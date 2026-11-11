import { ErrorCode, getToolBudget } from '@figwright/shared';

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
import { FigmaDeadlineError } from './figma-call.js';
import { SANDBOX_WRITE_TOOLS } from './handlers/registry.js';
import { WriteAbandonedError, WriteSignal } from './write-signal.js';

export type SandboxToolHandler = (
  params: unknown,
  /** `signal` is set for a write: the queue abandons it there when the write overruns its bound. */
  context?: { progress: (state: BatchProgress) => void; signal?: WriteSignal },
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
// write starts once the previous one settled, resolved or rejected, or was abandoned. Reads never
// wait here.
//
// A write still running at its bound is abandoned: its caller gets a named error, the next write
// starts, and the write's signal makes it change nothing more (no further batch op, no rollback),
// so the ordering guarantee above still holds. The bound is the tool's UI bridge budget less this
// margin, so the error reaches the caller before the bridge gives up, and it outlasts each Figma
// call's own deadline (budget less 10 s, figma-call.ts) so that more specific error wins.
//
// A write still waiting for its turn at its own bound, counted from when it was queued, fails with an
// error naming the write that blocks it, and never runs.
const ABANDON_MARGIN_MS = 3_000;

let writeTail: Promise<unknown> = Promise.resolve();
let running: { method: string; startedAt: number; signal: WriteSignal } | undefined;
let waitingCount = 0;
let lastFailed:
  | { method: string; outcome: 'abandoned' | 'deadline'; figmaCalls: string[]; at: number }
  | undefined;

/** The write queue as `ping` reports it; see the ping tool's description for the fields. */
export interface WriteQueueState {
  running: { method: string; runningMs: number; figmaCalls: string[] } | null;
  waiting: number;
  lastFailed: {
    method: string;
    outcome: 'abandoned' | 'deadline';
    figmaCalls: string[];
    agoMs: number;
  } | null;
}

export const writeQueueState = (): WriteQueueState => {
  const now = Date.now();
  return {
    running:
      running === undefined
        ? null
        : {
            method: running.method,
            runningMs: now - running.startedAt,
            figmaCalls: running.signal.waitingOn(),
          },
    waiting: waitingCount,
    lastFailed:
      lastFailed === undefined
        ? null
        : {
            method: lastFailed.method,
            outcome: lastFailed.outcome,
            figmaCalls: lastFailed.figmaCalls,
            agoMs: now - lastFailed.at,
          },
  };
};

const deadlineIn = (error: unknown): FigmaDeadlineError | undefined => {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (e instanceof FigmaDeadlineError) return e;
  }
  return undefined;
};

const blockedError = (method: string, boundMs: number): WriteAbandonedError => {
  const calls = running?.signal.waitingOn() ?? [];
  const blocker =
    running === undefined
      ? 'the writes ahead of it'
      : `${running.method}, running for ${Math.round((Date.now() - running.startedAt) / 1000)} s` +
        (calls.length === 0 ? '' : `, waiting on ${calls.join(', ')}`);
  return new WriteAbandonedError(
    `${method} did not start within ${boundMs / 1000} s: the sandbox write queue was blocked by ` +
      `${blocker}. It applied nothing and will not run; ping reports the write queue.`,
  );
};

const abandonedError = (
  method: string,
  boundMs: number,
  signal: WriteSignal,
  batch: BatchProgress | undefined,
): WriteAbandonedError => {
  const waiting = signal.waitingOn();
  const ran =
    `${method} was abandoned after ${boundMs / 1000} s: it was still running when the sandbox ` +
    'write queue stopped waiting, so later writes can run' +
    (waiting.length === 0 ? '.' : `. It was waiting on ${waiting.join(', ')}.`);
  if (method !== 'batch') {
    return new WriteAbandonedError(
      `${ran} It may have applied part of its change before this point and applies nothing ` +
        'after it. Figma work may still be running. Read back the targets before any retry.',
    );
  }
  const completed =
    batch === undefined
      ? 'completed op indexes unknown'
      : `completed op indexes=[${batch.completed.join(', ')}] (zero-based)`;
  return new WriteAbandonedError(
    `${ran} Batch outcome is unknown; ${completed}. It applies no further op and runs no ` +
      'rollback. Figma work may still be running. Read back the targets before any retry.',
  );
};

const enqueueWrite = (
  method: string,
  boundMs: number,
  signal: WriteSignal,
  lastProgress: () => BatchProgress | undefined,
  run: () => unknown,
): Promise<unknown> =>
  new Promise<unknown>((resolve, reject) => {
    waitingCount += 1;
    let gaveUp = false;
    const waitTimer = setTimeout(() => {
      gaveUp = true;
      waitingCount -= 1;
      reject(blockedError(method, boundMs));
    }, boundMs);
    // The tail settles when this write ends or is abandoned, never with its result, so a write that
    // gave up waiting leaves the next one queued behind the running write.
    writeTail = writeTail.then(() => {
      clearTimeout(waitTimer);
      if (gaveUp) return undefined;
      waitingCount -= 1;
      running = { method, startedAt: Date.now(), signal };
      // Before the caller hears back, so a ping sent on that reply no longer sees this write. A late
      // settle of an abandoned write leaves the next write's entry alone.
      const end = (): void => {
        if (running?.signal === signal) running = undefined;
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const overran = new Promise<void>(abandoned => {
        timer = setTimeout(() => {
          const error = abandonedError(method, boundMs, signal, lastProgress());
          lastFailed = {
            method,
            outcome: 'abandoned',
            figmaCalls: signal.waitingOn(),
            at: Date.now(),
          };
          signal.abandon(error);
          end();
          reject(error);
          abandoned();
        }, boundMs);
      });
      // Settling after the timer fired is a no-op, so a late result or rejection is dropped here.
      const settled = Promise.resolve()
        .then(run)
        .then(
          (value: unknown) => {
            end();
            resolve(value);
            return undefined;
          },
          (error: unknown) => {
            const deadline = deadlineIn(error);
            if (deadline !== undefined && !signal.abandoned) {
              // The call that missed its deadline never answered, so the signal still tracks it under
              // its full `figma.` path, the name the running entry showed.
              const tracked = signal.waitingOn().find(call => call.endsWith(`.${deadline.call}`));
              lastFailed = {
                method,
                outcome: 'deadline',
                figmaCalls: [tracked ?? `figma.${deadline.call}`],
                at: Date.now(),
              };
            }
            end();
            reject(error);
          },
        )
        .finally(() => clearTimeout(timer));
      return Promise.race([settled, overran]);
    });
  });

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
    const isWrite = SANDBOX_WRITE_TOOLS.has(method);
    const signal = isWrite ? new WriteSignal() : undefined;
    let lastProgress: BatchProgress | undefined;
    const run = (): unknown =>
      handler(params, {
        progress: state => {
          lastProgress = state;
          input.progress?.({ tag: PLUGIN_BRIDGE_TAG, kind: 'tool-progress', id, ...state });
        },
        ...(signal === undefined ? {} : { signal }),
      });
    const result = await (signal === undefined
      ? run()
      : enqueueWrite(
          method,
          getToolBudget(method, params) - ABANDON_MARGIN_MS,
          signal,
          () => lastProgress,
          run,
        ));
    return { kind: 'reply', reply: createToolResult({ id, result }) };
  } catch (err) {
    const raised = err instanceof Error ? err.message : String(err);
    log(`[sandbox] handler ${method} threw: ${raised}`);
    if (err instanceof WriteAbandonedError) {
      return {
        kind: 'reply',
        reply: createToolError({ id, code: ErrorCode.Timeout, message: raised }),
      };
    }
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
