import { ErrorCode } from '@figwright/shared';

import {
  createToolError,
  createToolResult,
  isPluginBridgeMessage,
  PLUGIN_BRIDGE_TAG,
  type BatchProgress,
  type PluginToolProgress,
  type PluginToolError,
  type PluginToolResult,
} from '../protocol/bridge.js';
import { withEditorContext } from '../protocol/editor-context.js';
import { SANDBOX_WRITE_TOOLS } from './handlers/registry.js';

export type SandboxToolHandler = (
  params: unknown,
  context?: { progress: (state: BatchProgress) => void },
) => unknown | Promise<unknown>;
export type SandboxHandlers = Record<string, SandboxToolHandler>;

export interface DispatchInput {
  raw: unknown;
  handlers: SandboxHandlers;
  /**
   * `figma.editorType`, so a handler error can name the editor it was raised in. Required rather
   * than optional on purpose: an optional field is exactly the kind of claim that gets silently
   * dropped at one call site and never noticed (see `editor-context.ts`).
   */
  editorType: string;
  log?: (msg: string) => void;
  progress?: (message: PluginToolProgress) => void;
}

export type DispatchOutcome =
  | { kind: 'reply'; reply: PluginToolResult | PluginToolError }
  | { kind: 'ignore' };

// One FIFO queue for every write in this sandbox. A batch captures old values, applies, and may roll
// back; letting another write run in between would let that rollback restore values over it. Each
// write starts once the previous one settled, resolved or rejected. Reads never wait here.
let writeTail: Promise<unknown> = Promise.resolve();

const enqueueWrite = (run: () => unknown): Promise<unknown> => {
  const result = writeTail.then(run);
  writeTail = result.catch(() => {});
  return result;
};

export const dispatchSandboxMessage = async (input: DispatchInput): Promise<DispatchOutcome> => {
  if (!isPluginBridgeMessage(input.raw)) return { kind: 'ignore' };
  if (input.raw.kind !== 'tool-call') return { kind: 'ignore' };

  const { id, method, params } = input.raw;
  const handler = input.handlers[method];
  const log = input.log ?? ((): void => {});

  if (handler === undefined) {
    log(`[sandbox] no handler for ${method}`);
    return {
      kind: 'reply',
      reply: createToolError({
        id,
        code: ErrorCode.MethodNotFound,
        message: `no sandbox handler (method=${method})`,
      }),
    };
  }

  try {
    const run = (): unknown =>
      handler(params, {
        progress: state =>
          input.progress?.({ tag: PLUGIN_BRIDGE_TAG, kind: 'tool-progress', id, ...state }),
      });
    const result = await (SANDBOX_WRITE_TOOLS.has(method) ? enqueueWrite(run) : run());
    return { kind: 'reply', reply: createToolResult({ id, result }) };
  } catch (err) {
    const raised = err instanceof Error ? err.message : String(err);
    log(`[sandbox] handler ${method} threw: ${raised}`);
    // FigJam and Dev Mode reject whole classes of call that Figma Design accepts, and the API's own
    // error rarely says which editor it came from. Naming it here is what lets an agent re-plan
    // instead of retrying the same call.
    return {
      kind: 'reply',
      reply: createToolError({
        id,
        code: ErrorCode.Internal,
        message: withEditorContext(raised, input.editorType),
      }),
    };
  }
};
