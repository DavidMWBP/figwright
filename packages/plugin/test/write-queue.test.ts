import { afterEach, describe, expect, it, vi } from 'vitest';

import { createToolCall, type PluginBridgeMessage, PluginToolFailure } from '../protocol/bridge.js';
import { dispatchSandboxMessage, type SandboxToolHandler } from '../src/dispatcher.js';
import { createIdempotencyCache, idempotent } from '../src/idempotency.js';
import { createToolBridge, type SubscribeFn } from '../ui/sandbox/tool-bridge.js';

// Writes share one FIFO queue in the sandbox, so a batch's capture/apply/rollback never interleaves
// with another write. Handlers here are fakes named after real write tools (batch, set_fills,
// set_text) and a real read (get_node); which names are writes comes from the sandbox registry.

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Let every queued microtask and one macrotask turn run, so a write that could start has started. */
const flush = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

const dispatch = (
  handlers: Record<string, SandboxToolHandler>,
  id: string,
  method: string,
  params?: unknown,
) =>
  dispatchSandboxMessage({
    raw: createToolCall({ id, method, ...(params === undefined ? {} : { params }) }),
    handlers,
    editorType: 'figma',
  });

/** A write handler that records its start and settles only when the test says so. */
const pendingWrite = (name: string, events: string[]) => {
  const started = deferred<void>();
  const done = deferred<unknown>();
  const handler = vi.fn<SandboxToolHandler>(() => {
    events.push(`${name}:start`);
    started.resolve();
    return done.promise;
  });
  return { handler, started: started.promise, done };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('sandbox write queue', () => {
  it('starts a second write only after the first settles', async () => {
    const events: string[] = [];
    const batch = pendingWrite('batch', events);
    const setFills = vi.fn<SandboxToolHandler>(() => {
      events.push('set_fills:start');
      return { ok: true };
    });
    const handlers = { batch: batch.handler, set_fills: setFills };

    const first = dispatch(handlers, 'w1', 'batch');
    await batch.started;
    const second = dispatch(handlers, 'w2', 'set_fills');
    await flush();
    events.push('batch:settled');
    batch.done.resolve({ applied: 1 });

    await Promise.all([first, second]);
    expect(events).toEqual(['batch:start', 'batch:settled', 'set_fills:start']);
  });

  it('runs a read at once while a write is pending', async () => {
    const events: string[] = [];
    const batch = pendingWrite('batch', events);
    const getNode = vi.fn<SandboxToolHandler>(() => ({ id: '1:2' }));
    const handlers = { batch: batch.handler, get_node: getNode };

    const write = dispatch(handlers, 'w1', 'batch');
    await batch.started;
    const read = await dispatch(handlers, 'r1', 'get_node');

    expect(read).toEqual({
      kind: 'reply',
      reply: expect.objectContaining({ kind: 'tool-result', id: 'r1', result: { id: '1:2' } }),
    });
    batch.done.resolve({ applied: 1 });
    await write;
  });

  it('runs the next write when the first one rejects', async () => {
    const events: string[] = [];
    const batch = pendingWrite('batch', events);
    const setFills = vi.fn<SandboxToolHandler>(() => ({ ok: true }));
    const handlers = { batch: batch.handler, set_fills: setFills };

    const first = dispatch(handlers, 'w1', 'batch');
    await batch.started;
    const second = dispatch(handlers, 'w2', 'set_fills');
    batch.done.reject(new Error('op 2 failed'));

    expect(await first).toEqual({
      kind: 'reply',
      reply: expect.objectContaining({ kind: 'tool-error', id: 'w1' }),
    });
    expect(await second).toEqual({
      kind: 'reply',
      reply: expect.objectContaining({ kind: 'tool-result', id: 'w2', result: { ok: true } }),
    });
    expect(setFills).toHaveBeenCalledTimes(1);
  });

  it('runs three writes one at a time in arrival order', async () => {
    const events: string[] = [];
    const batch = pendingWrite('batch', events);
    const setFills = pendingWrite('set_fills', events);
    const setText = pendingWrite('set_text', events);
    const handlers = {
      batch: batch.handler,
      set_fills: setFills.handler,
      set_text: setText.handler,
    };

    const outcomes = [
      dispatch(handlers, 'w1', 'batch'),
      dispatch(handlers, 'w2', 'set_fills'),
      dispatch(handlers, 'w3', 'set_text'),
    ];
    await flush();
    expect(events).toEqual(['batch:start']);

    batch.done.resolve(1);
    await flush();
    expect(events).toEqual(['batch:start', 'set_fills:start']);

    setFills.done.resolve(2);
    await flush();
    expect(events).toEqual(['batch:start', 'set_fills:start', 'set_text:start']);

    setText.done.resolve(3);
    await Promise.all(outcomes);
  });

  it('answers a same-requestId retry queued behind its original with the original result', async () => {
    const events: string[] = [];
    const batch = pendingWrite('batch', events);
    const handlers = { batch: idempotent(createIdempotencyCache(), batch.handler) };
    const params = { requestId: 'req-1', ops: [] };

    const original = dispatch(handlers, 'w1', 'batch', params);
    await batch.started;
    const retry = dispatch(handlers, 'w2', 'batch', params);
    const result = { applied: 2 };
    batch.done.resolve(result);

    const [originalOutcome, retryOutcome] = await Promise.all([original, retry]);
    expect(originalOutcome).toEqual({
      kind: 'reply',
      reply: expect.objectContaining({ kind: 'tool-result', id: 'w1', result }),
    });
    expect(retryOutcome).toEqual({
      kind: 'reply',
      reply: expect.objectContaining({ kind: 'tool-result', id: 'w2', result }),
    });
    expect(batch.handler).toHaveBeenCalledTimes(1);
  });

  it('still runs a queued write after its caller timed out, and drops the late reply', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const events: string[] = [];
    const batch = pendingWrite('batch', events);
    const setFills = vi.fn<SandboxToolHandler>(() => {
      events.push('set_fills:start');
      return { ok: true };
    });
    const handlers = { batch: batch.handler, set_fills: setFills };
    const log = vi.fn<(msg: string) => void>();

    // Wire the real UI bridge to the real dispatcher, the way the iframe and sandbox talk.
    const listener: { current: ((raw: unknown) => void) | null } = { current: null };
    const subscribe: SubscribeFn = cb => {
      listener.current = cb;
      return () => {
        listener.current = null;
      };
    };
    const bridge = createToolBridge({
      timeoutMs: 1000,
      log,
      subscribe,
      postMessage: (msg: PluginBridgeMessage) => {
        void (async (): Promise<void> => {
          const outcome = await dispatchSandboxMessage({ raw: msg, handlers, editorType: 'figma' });
          if (outcome.kind === 'reply') listener.current?.(outcome.reply);
        })();
      },
    });

    const batchCall = bridge.handler('batch', {}).catch((error: unknown) => error);
    await batch.started;
    const fillsCall = bridge.handler('set_fills', {}).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1000);
    expect(await fillsCall).toEqual(new Error('sandbox tool timeout (method=set_fills)'));
    expect(await batchCall).toBeInstanceOf(PluginToolFailure);
    expect(setFills).not.toHaveBeenCalled();

    batch.done.resolve({ applied: 1 });
    await flush();
    expect(events).toEqual(['batch:start', 'set_fills:start']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('orphan tool-result'));
    expect(bridge.pendingCount()).toBe(0);
    bridge.dispose();
  });
});
