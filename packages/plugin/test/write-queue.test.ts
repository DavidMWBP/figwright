import { afterEach, describe, expect, it, vi } from 'vitest';

import { createToolCall, type PluginBridgeMessage, PluginToolFailure } from '../protocol/bridge.js';
import { dispatchSandboxMessage, type SandboxToolHandler } from '../src/dispatcher.js';
import { createSandboxHandlers } from '../src/handlers/registry.js';
import { createSwapComponentHandler } from '../src/handlers/swap-component.js';
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

/** The real UI bridge, on each tool's real budget, wired to the real dispatcher. */
const bridgeTo = (handlers: Record<string, SandboxToolHandler>) => {
  const listener: { current: ((raw: unknown) => void) | null } = { current: null };
  return createToolBridge({
    subscribe: cb => {
      listener.current = cb;
      return () => {
        listener.current = null;
      };
    },
    postMessage: (msg: PluginBridgeMessage) => {
      void (async (): Promise<void> => {
        const outcome = await dispatchSandboxMessage({ raw: msg, handlers, editorType: 'figma' });
        if (outcome.kind === 'reply') listener.current?.(outcome.reply);
      })();
    },
  });
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

  it('runs the next write after a swap_component import never returns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const swapComponent = vi.fn<(component: unknown) => void>();
    const instance = { id: '1:1', type: 'INSTANCE', swapComponent };
    const imported = deferred<unknown>();
    const importComponentByKeyAsync = vi.fn<(key: string) => Promise<unknown>>(
      () => imported.promise,
    );
    const figmaCtx = {
      getNodeByIdAsync: async () => instance,
      importComponentByKeyAsync,
    } as unknown as typeof figma;
    const setFills = vi.fn<SandboxToolHandler>(() => ({ ok: true }));
    // The real bridge on its real per-tool budget: 30 s for both tools.
    const bridge = bridgeTo({
      swap_component: createSwapComponentHandler(figmaCtx),
      set_fills: setFills,
    });

    const swapCall = bridge
      .handler('swap_component', { instanceId: '1:1', componentKey: 'key-abc' })
      .catch((error: unknown) => error);
    await flush();
    expect(importComponentByKeyAsync).toHaveBeenCalledWith('key-abc');
    const fillsCall = bridge.handler('set_fills', {}).catch((error: unknown) => error);

    // Up to the bridge's own 30 s budget: the sandbox must have answered first, by name.
    await vi.advanceTimersByTimeAsync(30_000);
    const swapError = await swapCall;
    expect(swapError).toBeInstanceOf(PluginToolFailure);
    const message = (swapError as Error).message;
    expect(message).toContain('importComponentByKeyAsync(key-abc)');
    expect(message).toContain('20 s');
    expect(message).toContain('not cancelled');
    expect(message).toContain('Figma may defer library resolution in a background file');
    expect(await fillsCall).toEqual({ ok: true });

    // A late import changes nothing: the handler already gave up on it.
    imported.resolve({ id: 'C:9', type: 'COMPONENT' });
    await flush();
    expect(swapComponent).not.toHaveBeenCalled();
    bridge.dispose();
  });

  // Every Figma call a write handler bounds: the call, its target, the deadline (the tool's bridge
  // budget less 10 s), and the document change the handler would make once the call answers.
  const boundedCalls = () => {
    const pending = deferred<unknown>();
    const late = vi.fn<(value: unknown) => void>();
    const instance = { id: '1:1', type: 'INSTANCE', swapComponent: late };
    const rect = {
      id: '1:1',
      type: 'RECTANGLE',
      get fills() {
        return [];
      },
      set fills(value: unknown) {
        late(value);
      },
    };
    const figmaCtx = {
      mixed: Symbol('mixed'),
      getNodeByIdAsync: async (id: string) => (id === '1:1' ? instance : rect),
      importComponentByKeyAsync: () => pending.promise,
      importStyleByKeyAsync: () => pending.promise,
      variables: { importVariableByKeyAsync: () => pending.promise },
      saveVersionHistoryAsync: () => pending.promise,
      createImageAsync: () => pending.promise,
      createRectangle: () => {
        late('createRectangle');
        return rect;
      },
    } as unknown as typeof figma;
    return { pending, late, figmaCtx };
  };
  // What the handler would use the late answer for; none of it may run.
  const usedLate = vi.fn<(what: string) => void>();
  const lateComponent = {
    id: 'C:9',
    type: 'COMPONENT',
    createInstance: () => {
      usedLate('createInstance');
      return { id: '9:9' };
    },
  };
  const lateImage = {
    hash: 'h',
    getSizeAsync: async () => {
      usedLate('getSizeAsync');
      return { width: 1, height: 1 };
    },
  };
  const URL = 'https://example.test/a.png';
  it.each([
    [
      'swap_component',
      { instanceId: '1:1', componentKey: 'key-abc' },
      'importComponentByKeyAsync(key-abc)',
      30_000,
      20,
      lateComponent,
    ],
    [
      'create_instance',
      { componentKey: 'key-abc' },
      'importComponentByKeyAsync(key-abc)',
      30_000,
      20,
      lateComponent,
    ],
    [
      'import_style',
      { styleKey: 'key-abc' },
      'importStyleByKeyAsync(key-abc)',
      120_000,
      110,
      { id: 'S:1', name: 's' },
    ],
    [
      'import_variable',
      { variableKey: 'key-abc' },
      'importVariableByKeyAsync(key-abc)',
      120_000,
      110,
      { id: 'V:1', name: 'v' },
    ],
    [
      'save_version',
      { title: 'Before edits' },
      'saveVersionHistoryAsync("Before edits")',
      30_000,
      20,
      { id: 'version-1' },
    ],
    ['import_image', { url: URL }, `createImageAsync(${URL})`, 30_000, 20, lateImage],
    [
      'set_image_fill',
      { nodeId: '2:2', url: URL },
      `createImageAsync(${URL})`,
      30_000,
      20,
      lateImage,
    ],
  ])(
    '%s: a call that never answers ends with a named error before the bridge budget, and the next write runs',
    async (tool, params, call, budgetMs, deadlineS, lateValue) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      usedLate.mockClear();
      const { pending, late, figmaCtx } = boundedCalls();
      const setFills = vi.fn<SandboxToolHandler>(() => ({ ok: true }));
      const bridge = bridgeTo({
        [tool]: createSandboxHandlers(figmaCtx)[tool]!,
        set_fills: setFills,
      });

      const write = bridge.handler(tool, params).catch((error: unknown) => error);
      // Queue the next write while the first still waits, within the next write's own budget.
      await vi.advanceTimersByTimeAsync(deadlineS * 1000 - 1);
      const next = bridge.handler('set_fills', {}).catch((error: unknown) => error);
      await flush();
      expect(setFills).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(budgetMs - deadlineS * 1000);

      const error = await write;
      expect(error).toBeInstanceOf(PluginToolFailure);
      expect((error as Error).message).toContain(`${call} did not answer within ${deadlineS} s`);
      expect((error as Error).message).toContain('not cancelled and may still finish');
      expect(await next).toEqual({ ok: true });

      pending.resolve(lateValue);
      await flush();
      expect(late).not.toHaveBeenCalled();
      expect(usedLate).not.toHaveBeenCalled();
      bridge.dispose();
    },
  );
});
