import { execFile } from 'node:child_process';

import { z } from 'zod';

import type { PluginSessionInfo } from '../routing/sessions.js';
import { bindFileTarget, type FileTarget, type SessionSource } from '../routing/target.js';
import type { ToolSpec } from './spec.js';

export const OPEN_FILE_TOOL_NAME = 'open_file';
export const openFileTool: ToolSpec = {
  name: OPEN_FILE_TOOL_NAME,
  description:
    'Ask the OS URL opener to open a Figma file, wait for its Figwright plugin, then claim it ' +
    'for this agent as use_file does. The plugin must already be running in that file, or the ' +
    'user must start it there; this tool cannot start a plugin. In a Figma Design file where ' +
    'the plugin ran before, click "Run Figwright" in the right-hand panel with nothing selected ' +
    '(if file permissions allowed the button to be saved). Desktop URL handling ' +
    '(figma://design/<key>) was verified live on Windows on 2026-10-11; macOS (open) and Linux ' +
    '(xdg-open) have not been live-checked. Pass a file key or figma.com file/design URL. With fileName, match the exact ' +
    'name (duplicate names are refused); an already connected match is claimed without opening. ' +
    'Without fileName, claim the first session not connected when the call started, because ' +
    'public plugins cannot report file keys. Returns { ok: true, opened, sessionId, fileName, ' +
    'claim: { sessionId, fileName } }. Failures leave the current claim unchanged.',
  inputSchema: z.object({
    file: z.string().min(1).describe('Figma file key or figma.com file/design URL'),
    fileName: z.string().min(1).optional().describe('Expected exact file name'),
    timeoutSec: z
      .number()
      .positive()
      .max(600)
      .optional()
      .describe('Plugin wait in seconds, default 120, at most 600'),
  }),
  kind: 'local',
  serverOnlyArgs: null,
};

export type OpenFileSessions = SessionSource & {
  subscribe?: (listener: () => void) => () => void;
};
export interface OpenFileClock {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}
export interface OpenFileResult {
  ok: true;
  opened: boolean;
  sessionId: string;
  fileName: string | null;
  claim: FileTarget;
}

// Checked live on Figma desktop (Windows) on 2026-10-11; macOS (open) and Linux
// (xdg-open) have not been live-checked.
const FILE_URL_PREFIX = 'figma://design/';
const POLL_INTERVAL_MS = 250;

export const buildOpenFileUrl = (file: string): string => {
  let key = file;
  if (!/^[a-zA-Z0-9]+$/.test(key)) {
    try {
      const url = new URL(file);
      if (
        url.protocol !== 'https:' ||
        !['figma.com', 'www.figma.com'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        throw new Error('invalid host');
      const match = /^\/(?:file|design)\/([a-zA-Z0-9]+)(?:\/|$)/.exec(url.pathname);
      if (!match) throw new Error('invalid path');
      key = match[1]!;
    } catch {
      throw new Error('open_file needs a file key or a valid Figma file/design URL');
    }
  }
  return FILE_URL_PREFIX + key;
};

export const openerCommand = (url: string, platform: NodeJS.Platform) => {
  if (platform === 'win32') return { command: 'cmd', args: ['/c', `start "" ${url}`] };
  return { command: platform === 'darwin' ? 'open' : 'xdg-open', args: [url] };
};

const openUrl = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const { command, args } = openerCommand(url, process.platform);
    execFile(
      command,
      args,
      { windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' },
      error => {
        if (error) reject(error);
        else resolve();
      },
    );
  });

const systemClock: OpenFileClock = {
  now: Date.now,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export const handleOpenFile = async (
  args: Record<string, unknown>,
  sessions: OpenFileSessions,
  options: { open?: (url: string) => Promise<void>; clock?: OpenFileClock } = {},
): Promise<OpenFileResult> => {
  // Validate before even the already-connected shortcut, so malformed input never opens a URL.
  const url = buildOpenFileUrl(typeof args.file === 'string' ? args.file : '');
  const input = openFileTool.inputSchema.parse(args) as {
    file: string;
    fileName?: string;
    timeoutSec?: number;
  };
  const initial = await sessions();
  const connectedIds = new Set(initial.map(s => s.id));
  const candidates = (current: readonly PluginSessionInfo[]) =>
    input.fileName === undefined
      ? current.filter(s => !connectedIds.has(s.id))
      : current.filter(s => s.fileName === input.fileName);
  const claim = async (
    current: readonly PluginSessionInfo[],
    opened: boolean,
  ): Promise<OpenFileResult> => {
    // Filter exact names here; bindFileTarget's user-friendly name matching is broader.
    const matches = candidates(current);
    const { target } = await bindFileTarget(
      async () => matches,
      input.fileName === undefined ? { sessionId: matches[0]!.id } : { fileName: input.fileName },
    );
    return {
      ok: true,
      opened,
      sessionId: target.sessionId,
      fileName: target.fileName,
      claim: target,
    };
  };
  if (input.fileName !== undefined && candidates(initial).length > 0) return claim(initial, false);
  await (options.open ?? openUrl)(url);
  const clock = options.clock ?? systemClock;
  const timeoutMs = (input.timeoutSec ?? 120) * 1000;
  const deadline = clock.now() + timeoutMs;
  const timeoutError = () =>
    new Error(
      `Timed out waiting for "${input.fileName ?? input.file}" — start the Figwright plugin in that tab ` +
        '(in a Figma Design file where it ran before, click "Run Figwright" in the right-hand panel ' +
        'with nothing selected, if file permissions allowed the button to be saved), ' +
        'and call open_file again (or use_file).',
    );
  const current = await new Promise<readonly PluginSessionInfo[]>((resolve, reject) => {
    let settled = false;
    let checking = false;
    let dirty = false;
    let poll: unknown;
    let unsubscribe: (() => void) | undefined;
    const finish = (value?: readonly PluginSessionInfo[], error?: unknown) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timeout);
      if (poll !== undefined) clock.clearTimeout(poll);
      unsubscribe?.();
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    const timeout = clock.setTimeout(() => finish(undefined, timeoutError()), timeoutMs);
    const check = async () => {
      if (settled) return;
      if (checking) {
        dirty = true;
        return;
      }
      checking = true;
      try {
        do {
          dirty = false;
          // Session events that arrive during a read require another read, in order.
          // eslint-disable-next-line no-await-in-loop
          const listed = await sessions();
          if (settled) return;
          if (clock.now() >= deadline) {
            finish(undefined, timeoutError());
            return;
          }
          if (candidates(listed).length > 0) {
            finish(listed);
            return;
          }
        } while (dirty);
        if (!sessions.subscribe)
          poll = clock.setTimeout(
            () => {
              void check();
            },
            Math.min(POLL_INTERVAL_MS, deadline - clock.now()),
          );
      } catch (error) {
        finish(undefined, error);
      } finally {
        checking = false;
      }
    };
    unsubscribe = sessions.subscribe?.(() => {
      void check();
    });
    void check();
  });
  return claim(current, true);
};
