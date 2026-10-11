import { execFile } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginSessionInfo } from '../../src/routing/sessions.js';
import { clearFileTarget, getFileTarget, setFileTarget } from '../../src/routing/target.js';
import {
  buildOpenFileUrl,
  handleOpenFile,
  openerCommand,
  type OpenFileClock,
  type OpenFileSessions,
} from '../../src/tools/open-file.js';

const session = (id: string, fileName: string | null): PluginSessionInfo => ({
  id,
  fileName,
  pageName: null,
  lastActivityAt: 0,
  pluginVersion: '0.5.0',
});
const oldClaim = { sessionId: 'old', fileName: 'Original' };
vi.mock('node:child_process', () => ({ execFile: vi.fn<typeof execFile>() }));
const clock: OpenFileClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const source = (initial: PluginSessionInfo[] = []) => {
  let sessions = initial;
  const listeners = new Set<() => void>();
  const read: OpenFileSessions = vi.fn<OpenFileSessions>(async () => sessions);
  read.subscribe = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    read,
    update(next: PluginSessionInfo[]) {
      sessions = next;
      for (const listener of listeners) listener();
    },
    listeners,
  };
};
beforeEach(() => {
  vi.useFakeTimers();
  setFileTarget(oldClaim);
});
afterEach(() => {
  vi.useRealTimers();
  clearFileTarget();
});

describe('open_file', () => {
  it.each([
    'AbC123',
    'https://www.figma.com/design/AbC123/Example?node-id=1-2',
    'https://www.figma.com/file/AbC123/Example',
  ])('builds the isolated URL form for %s', file => {
    expect(buildOpenFileUrl(file)).toBe('figma://design/AbC123');
  });
  it.each([
    '',
    ' ',
    'https://evil.test/design/AbC123',
    'https://www.figma.com/design/',
    'https://www.figma.com/design/AbC%22',
    'https://www.figma.com/not-a-file/AbC123',
  ])('refuses invalid input %s before opening', async file => {
    const open = vi.fn<(url: string) => Promise<void>>();
    const error = await handleOpenFile({ file }, source().read, { open, clock }).catch(e => e);
    expect({ message: error.message, calls: open.mock.calls, claim: getFileTarget() }).toEqual({
      message: expect.stringMatching(/file key|Figma.*URL/i),
      calls: [],
      claim: oldClaim,
    });
  });
  it('claims an exact connected name without opening', async () => {
    const open = vi.fn<(url: string) => Promise<void>>();
    const result = await handleOpenFile(
      { file: 'AbC123', fileName: 'Target' },
      source([session('s1', 'Target')]).read,
      { open, clock },
    );
    expect({ result, calls: open.mock.calls, claim: getFileTarget() }).toEqual({
      result: {
        ok: true,
        opened: false,
        sessionId: 's1',
        fileName: 'Target',
        claim: { sessionId: 's1', fileName: 'Target' },
      },
      calls: [],
      claim: { sessionId: 's1', fileName: 'Target' },
    });
  });
  it('claims the first newly connected session, not an existing session', async () => {
    const sessions = source([session('old', 'Original')]);
    const open = vi.fn<(url: string) => Promise<void>>(async () => {
      sessions.update([session('old', 'Original'), session('new', 'Target')]);
    });
    const result = await handleOpenFile({ file: 'AbC123' }, sessions.read, { open, clock });
    expect({
      result,
      calls: open.mock.calls,
      claim: getFileTarget(),
      listeners: sessions.listeners.size,
    }).toEqual({
      result: {
        ok: true,
        opened: true,
        sessionId: 'new',
        fileName: 'Target',
        claim: { sessionId: 'new', fileName: 'Target' },
      },
      calls: [['figma://design/AbC123']],
      claim: { sessionId: 'new', fileName: 'Target' },
      listeners: 0,
    });
  });
  it('ignores another name and uses session events to keep waiting', async () => {
    const sessions = source();
    let notifyOpened!: () => void;
    const opened = new Promise<void>(resolve => {
      notifyOpened = resolve;
    });
    const open = vi.fn<(url: string) => Promise<void>>(async () => {
      notifyOpened();
    });
    const pending = handleOpenFile({ file: 'AbC123', fileName: 'Target' }, sessions.read, {
      open,
      clock,
    });
    await opened;
    sessions.update([session('wrong', 'target')]);
    await vi.advanceTimersByTimeAsync(0);
    const before = getFileTarget();
    sessions.update([session('wrong', 'target'), session('right', 'Target')]);
    const result = await pending;
    expect({ before, result: result.sessionId, listeners: sessions.listeners.size }).toEqual({
      before: oldClaim,
      result: 'right',
      listeners: 0,
    });
  });
  it.each([false, true])('refuses duplicate names (after opening: %s)', async afterOpen => {
    const duplicates = [session('a', 'Target'), session('b', 'Target')];
    const sessions = source(afterOpen ? [] : duplicates);
    const open = vi.fn<(url: string) => Promise<void>>(async () => {
      sessions.update(duplicates);
    });
    const error = await handleOpenFile({ file: 'AbC123', fileName: 'Target' }, sessions.read, {
      open,
      clock,
    }).catch(e => e);
    expect({
      message: error.message,
      claim: getFileTarget(),
      opens: open.mock.calls.length,
    }).toEqual({
      message: expect.stringMatching(/matches 2 open files/),
      claim: oldClaim,
      opens: afterOpen ? 1 : 0,
    });
  });
  it('times out with recovery guidance and leaves the claim unchanged', async () => {
    const sessions = source();
    const pending = handleOpenFile({ file: 'AbC123', fileName: 'Target' }, sessions.read, {
      open: async () => {},
      clock,
    }).catch(e => e);
    await vi.advanceTimersByTimeAsync(120_000);
    const error = await pending;
    expect({
      message: error.message,
      claim: getFileTarget(),
      listeners: sessions.listeners.size,
    }).toEqual({
      message: expect.stringMatching(
        /Target.*start the Figwright plugin.*open_file again.*use_file/i,
      ),
      claim: oldClaim,
      listeners: 0,
    });
  });
  it('propagates opener failure without changing the claim', async () => {
    const error = await handleOpenFile({ file: 'AbC123' }, source().read, {
      open: async () => {
        throw new Error('opener exited 7');
      },
      clock,
    }).catch(e => e);
    expect({ message: error.message, claim: getFileTarget() }).toEqual({
      message: 'opener exited 7',
      claim: oldClaim,
    });
  });
  it('polls a source without events using a deadline that includes source work', async () => {
    let reads = 0;
    const read = async () => {
      reads++;
      vi.advanceTimersByTime(200);
      return [];
    };
    const pending = handleOpenFile({ file: 'AbC123', timeoutSec: 1 }, read, {
      open: async () => {},
      clock,
    }).catch(e => e);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await pending;
    // Snapshot at 0; wait reads at 200, 650, 1100. Work crosses the deadline at 1200.
    expect({ message: error.message, reads, claim: getFileTarget() }).toEqual({
      message: expect.stringMatching(/AbC123.*start the Figwright plugin/),
      reads: 4,
      claim: oldClaim,
    });
  });
  it('polls and claims a new session without events', async () => {
    let sessions: PluginSessionInfo[] = [];
    const pending = handleOpenFile({ file: 'AbC123' }, async () => sessions, {
      open: async () => {},
      clock,
    });
    await vi.advanceTimersByTimeAsync(0);
    sessions = [session('new', 'Target')];
    await vi.advanceTimersByTimeAsync(250);
    expect((await pending).claim).toEqual({ sessionId: 'new', fileName: 'Target' });
  });
  it('never claims a session returned by a read after timeout', async () => {
    let finishRead!: (sessions: PluginSessionInfo[]) => void;
    const delayed = new Promise<PluginSessionInfo[]>(resolve => {
      finishRead = resolve;
    });
    let reads = 0;
    const pending = handleOpenFile(
      { file: 'AbC123', timeoutSec: 1 },
      async () => {
        return ++reads === 1 ? [] : delayed;
      },
      { open: async () => {}, clock },
    ).catch(e => e);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await pending;
    finishRead([session('late', 'Target')]);
    await vi.advanceTimersByTimeAsync(0);
    expect({ message: error.message, claim: getFileTarget() }).toEqual({
      message: expect.stringMatching(/AbC123.*start the Figwright plugin/),
      claim: oldClaim,
    });
  });
  it.each([0, -1, 601])('refuses timeoutSec %s', async timeoutSec => {
    const open = vi.fn<(url: string) => Promise<void>>();
    const error = await handleOpenFile({ file: 'AbC123', timeoutSec }, source().read, {
      open,
      clock,
    }).catch(e => e);
    expect({
      invalid: error instanceof Error,
      calls: open.mock.calls,
      claim: getFileTarget(),
    }).toEqual({ invalid: true, calls: [], claim: oldClaim });
  });
  it('accepts the maximum timeout', async () => {
    expect(
      (
        await handleOpenFile(
          { file: 'AbC123', fileName: 'Target', timeoutSec: 600 },
          source([session('s1', 'Target')]).read,
          { open: vi.fn<(url: string) => Promise<void>>(), clock },
        )
      ).sessionId,
    ).toBe('s1');
  });
  it('refuses an empty expected file name', async () => {
    const open = vi.fn<(url: string) => Promise<void>>();
    const error = await handleOpenFile({ file: 'AbC123', fileName: '' }, source().read, {
      open,
      clock,
    }).catch(e => e);
    expect({ invalid: error instanceof Error, calls: open.mock.calls }).toEqual({
      invalid: true,
      calls: [],
    });
  });
  it.each(['spawn ENOENT', 'Command failed: opener exited 7'])(
    'propagates the OS adapter error: %s',
    async message => {
      vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
        const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
        callback(new Error(message), '', '');
        return {} as ReturnType<typeof execFile>;
      });
      const error = await handleOpenFile({ file: 'AbC123' }, source().read, { clock }).catch(
        e => e,
      );
      expect({ message: error.message, claim: getFileTarget() }).toEqual({
        message,
        claim: oldClaim,
      });
    },
  );
  it('uses the OS adapter command and claims the session after a successful exit', async () => {
    const sessions = source();
    vi.mocked(execFile).mockClear();
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      sessions.update([session('new', null)]);
      const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
      callback(null, '', '');
      return {} as ReturnType<typeof execFile>;
    });
    const result = await handleOpenFile({ file: 'AbC123' }, sessions.read, { clock });
    const expectedCommands = {
      win32: ['cmd', ['/c', 'start "" figma://design/AbC123']],
      darwin: ['open', ['figma://design/AbC123']],
      linux: ['xdg-open', ['figma://design/AbC123']],
    };
    expect({ result, call: vi.mocked(execFile).mock.calls[0] }).toEqual({
      result: {
        ok: true,
        opened: true,
        sessionId: 'new',
        fileName: null,
        claim: { sessionId: 'new', fileName: null },
      },
      call: [
        ...expectedCommands[process.platform as keyof typeof expectedCommands],
        { windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' },
        expect.any(Function),
      ],
    });
  });
  it.each([
    ['win32', 'cmd', ['/c', 'start "" figma://design/AbC123']],
    ['darwin', 'open', ['figma://design/AbC123']],
    ['linux', 'xdg-open', ['figma://design/AbC123']],
  ] as const)('builds the %s opener command', (platform, command, args) => {
    expect(openerCommand('figma://design/AbC123', platform)).toEqual({ command, args });
  });
});
