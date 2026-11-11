import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// A write still running at its queue bound is abandoned so later writes can run. The bound is the
// tool's bridge budget less 3 s: 27 s on the default 30 s budget, and for a batch of four ops
// 157 s (120 s + 4 × 10 s, less 3 s).
describe('sandbox write queue: abandoning a write that overruns', () => {
  /** A Figma fake whose lookup of `1:2` waits until the test answers it; other ids answer at once. */
  const hangingLookup = () => {
    const lookup = deferred<unknown>();
    const fillsWritten = vi.fn<(value: unknown) => void>();
    const rect = {
      id: '1:2',
      type: 'RECTANGLE',
      get fills() {
        return [];
      },
      set fills(value: unknown) {
        fillsWritten(value);
      },
    };
    const getNodeByIdAsync = vi.fn<(id: string) => Promise<unknown>>(id =>
      id === '1:2' ? lookup.promise : Promise.resolve(null),
    );
    const figmaCtx = { mixed: Symbol('mixed'), getNodeByIdAsync } as unknown as typeof figma;
    return { lookup, rect, fillsWritten, figmaCtx };
  };
  const RED = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];

  it('abandons a write still running at its bound with an error naming it, and runs the next write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { figmaCtx } = hangingLookup();
    const setOpacity = vi.fn<SandboxToolHandler>(() => ({ ok: true }));
    const bridge = bridgeTo({
      set_fills: createSandboxHandlers(figmaCtx).set_fills!,
      set_opacity: setOpacity,
    });

    const write = bridge
      .handler('set_fills', { nodeId: '1:2', fills: RED })
      .catch((error: unknown) => error);
    await flush();
    const next = bridge.handler('set_opacity', {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(26_999);
    expect(setOpacity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const error = await write;
    expect(error).toBeInstanceOf(PluginToolFailure);
    expect((error as PluginToolFailure).code).toBe('TIMEOUT');
    const message = (error as Error).message;
    expect(message).toContain('set_fills was abandoned after 27 s');
    expect(message).toContain('waiting on figma.getNodeByIdAsync(1:2)');
    expect(await next).toEqual({ ok: true });
    bridge.dispose();
  });

  it('runs three writes queued behind an abandoned one, in arrival order', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const events: string[] = [];
    const stuck = vi.fn<SandboxToolHandler>(() => new Promise<never>(() => {}));
    const record = (name: string) =>
      vi.fn<SandboxToolHandler>(() => {
        events.push(name);
        return name;
      });
    const bridge = bridgeTo({
      set_text: stuck,
      set_fills: record('set_fills'),
      set_opacity: record('set_opacity'),
      rename_node: record('rename_node'),
    });

    const first = bridge.handler('set_text', {}).catch((error: unknown) => error);
    // Queued 1 s later, so each queued write's own 27 s bound falls after the first's.
    await vi.advanceTimersByTimeAsync(1_000);
    const queued = [
      bridge.handler('set_fills', {}),
      bridge.handler('set_opacity', {}),
      bridge.handler('rename_node', {}),
    ];
    await vi.advanceTimersByTimeAsync(25_999);
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBeInstanceOf(PluginToolFailure);
    expect(await Promise.all(queued)).toEqual(['set_fills', 'set_opacity', 'rename_node']);
    expect(events).toEqual(['set_fills', 'set_opacity', 'rename_node']);
    bridge.dispose();
  });

  it('changes nothing when the abandoned write’s Figma call answers later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { lookup, rect, fillsWritten, figmaCtx } = hangingLookup();
    const bridge = bridgeTo({ set_fills: createSandboxHandlers(figmaCtx).set_fills! });

    const write = bridge
      .handler('set_fills', { nodeId: '1:2', fills: RED })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(27_000);
    expect(await write).toBeInstanceOf(PluginToolFailure);

    lookup.resolve(rect);
    await flush();
    expect(fillsWritten).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it('changes nothing when the abandoned write was waiting on a node’s own method', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // image.getSizeAsync is the image's method, not a figma.* call, so no Figma guard covers it.
    const size = deferred<{ width: number; height: number }>();
    const { rect, fillsWritten } = hangingLookup();
    const figmaCtx = {
      mixed: Symbol('mixed'),
      getNodeByIdAsync: async () => rect,
      base64Decode: () => new Uint8Array(),
      createImage: () => ({ hash: 'h', getSizeAsync: () => size.promise }),
    } as unknown as typeof figma;
    const bridge = bridgeTo({ set_image_fill: createSandboxHandlers(figmaCtx).set_image_fill! });

    const write = bridge
      .handler('set_image_fill', { nodeId: '1:2', data: 'AA==' })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(27_000);
    expect((await write) as Error).toBeInstanceOf(PluginToolFailure);
    expect(((await write) as Error).message).not.toContain('waiting on');

    size.resolve({ width: 10, height: 10 });
    await flush();
    expect(fillsWritten).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it('gives a write that finishes just inside its bound its own result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const events: string[] = [];
    const setText = pendingWrite('set_text', events);
    const bridge = bridgeTo({ set_text: setText.handler });

    const write = bridge.handler('set_text', {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(26_999);
    setText.done.resolve({ ok: true, nodeId: '1:2' });
    expect(await write).toEqual({ ok: true, nodeId: '1:2' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bridge.pendingCount()).toBe(0);
    bridge.dispose();
  });

  it('stops an abandoned rollback after a node style setter answers late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const style = deferred<void>();
    const styleStarted = deferred<void>();
    const setBoundVariable = vi.fn<(field: string, variable: { id: string } | null) => void>();
    const setFillStyleIdAsync = vi.fn<() => Promise<void>>(async () => {});
    let weight = 1;
    let bindings: Record<string, { type: string; id: string }> = {
      strokeWeight: { type: 'VARIABLE_ALIAS', id: 'V:old' },
    };
    const rect = {
      id: '1:1',
      type: 'RECTANGLE',
      parent: null,
      strokes: [],
      opacity: 1,
      strokeStyleId: 'S:old',
      get strokeWeight() {
        return weight;
      },
      set strokeWeight(value: number) {
        weight = value;
        bindings = {};
      },
      get boundVariables() {
        return bindings;
      },
      setBoundVariable: (field: string, variable: { id: string } | null) => {
        setBoundVariable(field, variable);
        bindings =
          variable === null ? {} : { [field]: { type: 'VARIABLE_ALIAS', id: variable.id } };
      },
      setStrokeStyleIdAsync: vi.fn<() => Promise<void>>(async () => {
        styleStarted.resolve();
        await style.promise;
      }),
    };
    const filled = {
      id: '1:2',
      type: 'RECTANGLE',
      parent: null,
      fills: [],
      fillStyleId: 'S:fill',
      setFillStyleIdAsync,
    };
    // Figma detaches a paint style on a raw paint write, even for an identical value.
    Object.defineProperty(rect, 'strokes', {
      get: () => [],
      set: () => {
        rect.strokeStyleId = '';
      },
    });
    Object.defineProperty(filled, 'fills', {
      get: () => [],
      set: () => {
        filled.fillStyleId = '';
      },
    });
    const figmaCtx = {
      root: { children: [] },
      getNodeByIdAsync: async (id: string) => (id === rect.id ? rect : filled),
      variables: { getVariableByIdAsync: async (id: string) => ({ id }) },
    } as unknown as typeof figma;
    const handlers = createSandboxHandlers(figmaCtx);
    const bridge = bridgeTo(handlers);
    const write = bridge
      .handler('batch', {
        ops: [
          { tool: 'set_fills', params: { nodeId: filled.id, fills: [] } },
          { tool: 'set_strokes', params: { nodeId: rect.id, strokes: [], strokeWeight: 2 } },
          // Capture succeeds; apply rejects and starts rollback of ops 1 and 0.
          { tool: 'set_opacity', params: { nodeId: rect.id, opacity: 'invalid' } },
        ],
      })
      .catch((error: unknown) => error);
    await styleStarted.promise;
    expect(rect.setStrokeStyleIdAsync).toHaveBeenCalledOnce();
    expect(rect.strokeWeight).toBe(1);
    await vi.advanceTimersByTimeAsync(147_000);
    expect(((await write) as Error).message).toContain('batch was abandoned after 147 s');

    await bridge.handler('bind_variable_to_node', {
      nodeId: rect.id,
      field: 'strokeWeight',
      variableId: 'V:new',
    });
    expect(setBoundVariable).toHaveBeenLastCalledWith('strokeWeight', { id: 'V:new' });
    setBoundVariable.mockClear();
    style.resolve();
    await flush();
    expect(setFillStyleIdAsync).not.toHaveBeenCalled();
    expect(setBoundVariable).not.toHaveBeenCalled();
    expect(rect.boundVariables.strokeWeight?.id).toBe('V:new');
    bridge.dispose();
  });

  it('drops a late rejection of an abandoned write: no unhandled rejection, one reply', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const unhandled = vi.fn<(reason: unknown) => void>();
    process.on('unhandledRejection', unhandled);
    try {
      const events: string[] = [];
      const setText = pendingWrite('set_text', events);
      const replies: unknown[] = [];
      const log = vi.fn<(msg: string) => void>();
      const outcome = dispatchSandboxMessage({
        raw: createToolCall({ id: 'w1', method: 'set_text' }),
        handlers: { set_text: setText.handler },
        editorType: 'figma',
        log,
      }).then(reply => replies.push(reply));
      await vi.advanceTimersByTimeAsync(27_000);
      await outcome;
      expect(replies).toEqual([
        {
          kind: 'reply',
          reply: expect.objectContaining({ kind: 'tool-error', id: 'w1', code: 'TIMEOUT' }),
        },
      ]);

      setText.done.reject(new Error('late failure'));
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
      expect(replies).toHaveLength(1);
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('late failure'));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('answers a same-requestId retry after abandonment without waiting on the abandoned write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stuck = vi.fn<SandboxToolHandler>(() => new Promise<never>(() => {}));
    const handlers = { set_text: idempotent(createIdempotencyCache(), stuck) };
    const params = { requestId: 'req-1', nodeId: '1:2', text: 'Hi' };

    const original = dispatch(handlers, 'w1', 'set_text', params);
    await vi.advanceTimersByTimeAsync(27_000);
    expect(await original).toEqual({
      kind: 'reply',
      reply: expect.objectContaining({ kind: 'tool-error', id: 'w1', code: 'TIMEOUT' }),
    });

    // No timer moves from here: the retry must answer on its own, not at its own bound.
    const retry = await dispatch(handlers, 'w2', 'set_text', params);
    expect(retry).toEqual({
      kind: 'reply',
      reply: expect.objectContaining({
        kind: 'tool-error',
        id: 'w2',
        code: 'TIMEOUT',
        message: expect.stringContaining('set_text was abandoned after 27 s'),
      }),
    });
    expect(stuck).toHaveBeenCalledTimes(1);
  });

  /**
   * A batch of four ops: set_opacity on 1:1 and 1:2, then set_reactions on 1:3 whose
   * setReactionsAsync waits until the test answers it, then set_opacity on 1:4.
   */
  const hangingBatch = () => {
    const reactions = deferred<void>();
    const opacityWrites: string[] = [];
    const node = (id: string): Record<string, unknown> => {
      let opacity = 1;
      return {
        id,
        type: 'RECTANGLE',
        reactions: [],
        setReactionsAsync: () => reactions.promise,
        get opacity() {
          return opacity;
        },
        set opacity(value: number) {
          opacityWrites.push(`${id}=${value}`);
          opacity = value;
        },
      };
    };
    const nodes = new Map(['1:1', '1:2', '1:3', '1:4'].map(id => [id, node(id)]));
    const figmaCtx = {
      mixed: Symbol('mixed'),
      root: { children: [] },
      getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    } as unknown as typeof figma;
    const params = {
      ops: [
        { tool: 'set_opacity', params: { nodeId: '1:1', opacity: 0.5 } },
        { tool: 'set_opacity', params: { nodeId: '1:2', opacity: 0.5 } },
        { tool: 'set_reactions', params: { nodeId: '1:3', reactions: [] } },
        { tool: 'set_opacity', params: { nodeId: '1:4', opacity: 0.5 } },
      ],
    };
    return { reactions, opacityWrites, figmaCtx, params };
  };

  it.each(['resolves', 'rejects'] as const)(
    'an abandoned batch whose hanging op %s later applies no further op and runs no rollback',
    async late => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { reactions, opacityWrites, figmaCtx, params } = hangingBatch();
      const phases: string[] = [];
      const outcome = dispatchSandboxMessage({
        raw: createToolCall({ id: 'b1', method: 'batch', params }),
        handlers: { batch: createSandboxHandlers(figmaCtx).batch! },
        editorType: 'figma',
        progress: state => phases.push(`${state.phase}:${state.inFlight.join(',')}`),
      });
      await flush();
      expect(opacityWrites).toEqual(['1:1=0.5', '1:2=0.5']);
      expect(phases.at(-1)).toBe('apply:2');

      await vi.advanceTimersByTimeAsync(157_000);
      const reply = await outcome;
      expect(reply).toEqual({
        kind: 'reply',
        reply: expect.objectContaining({ kind: 'tool-error', id: 'b1', code: 'TIMEOUT' }),
      });
      const message = (reply as { reply: { message: string } }).reply.message;
      expect(message).toContain('batch was abandoned after 157 s');
      expect(message).toContain('outcome is unknown');
      expect(message).toContain('completed op indexes=[0, 1]');
      expect(message).toContain('Read back the targets');

      const phasesAtAbandon = phases.length;
      if (late === 'resolves') reactions.resolve();
      else reactions.reject(new Error('late failure'));
      await flush();
      await flush();
      expect(opacityWrites).toEqual(['1:1=0.5', '1:2=0.5']);
      const after = phases.slice(phasesAtAbandon);
      expect(after.filter(p => p.startsWith('rollback') || p === 'apply:3')).toEqual([]);
    },
  );
});

// `ping` is a read, so it answers while a write is stuck, and reports the queue: the running write,
// how many wait, and the last write that was abandoned or missed a Figma call deadline. The queue
// is module state that lives as long as the plugin, so each test loads a fresh copy of it.
describe('sandbox write queue: what ping reports', () => {
  let dispatchFresh: typeof dispatchSandboxMessage;
  let handlersFor: typeof createSandboxHandlers;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    ({ dispatchSandboxMessage: dispatchFresh } = await import('../src/dispatcher.js'));
    ({ createSandboxHandlers: handlersFor } = await import('../src/handlers/registry.js'));
  });

  /** The real bridge on each tool's real budget, wired to this test's fresh dispatcher. */
  const freshBridge = (handlers: Record<string, SandboxToolHandler>) => {
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
          const outcome = await dispatchFresh({ raw: msg, handlers, editorType: 'figma' });
          if (outcome.kind === 'reply') listener.current?.(outcome.reply);
        })();
      },
    });
  };

  /** A Figma fake that answers ping, and whose lookup of `1:2` waits until the test answers it. */
  const figmaWithHangingLookup = (extra: Record<string, unknown> = {}) =>
    ({
      apiVersion: '1.0.0',
      editorType: 'figma',
      currentPage: { id: '0:1', name: 'Page 1' },
      fileKey: null,
      mixed: Symbol('mixed'),
      root: { children: [] },
      getNodeByIdAsync: (id: string) => (id === '1:2' ? new Promise(() => {}) : null),
      ...extra,
    }) as unknown as typeof figma;
  const RED = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];

  const pingQueue = async (bridge: ReturnType<typeof freshBridge>): Promise<unknown> =>
    ((await bridge.handler('ping', {})) as { writeQueue: unknown }).writeQueue;

  it('reports an idle queue: nothing running, nothing waiting, nothing failed', async () => {
    const bridge = freshBridge(handlersFor(figmaWithHangingLookup()));

    expect(await pingQueue(bridge)).toEqual({ running: null, waiting: 0, lastFailed: null });
    bridge.dispose();
  });

  it('names the hanging write, its Figma call and the writes behind it, then the abandoned one', async () => {
    const real = handlersFor(figmaWithHangingLookup());
    const next = deferred<unknown>();
    const setOpacity = vi.fn<SandboxToolHandler>(() => next.promise);
    const bridge = freshBridge({
      ping: real.ping!,
      set_fills: real.set_fills!,
      set_opacity: setOpacity,
      rename_node: () => 'renamed',
    });

    const stuck = bridge
      .handler('set_fills', { nodeId: '1:2', fills: RED })
      .catch((error: unknown) => error);
    // Each queued write's own 27 s bound runs from when it was queued: 28 s and 32 s here.
    await vi.advanceTimersByTimeAsync(1_000);
    const queued = [bridge.handler('set_opacity', {})];
    await vi.advanceTimersByTimeAsync(4_000);
    queued.push(bridge.handler('rename_node', {}));

    expect(await pingQueue(bridge)).toEqual({
      running: {
        method: 'set_fills',
        runningMs: 5_000,
        figmaCalls: ['figma.getNodeByIdAsync(1:2)'],
      },
      waiting: 2,
      lastFailed: null,
    });

    // set_fills is abandoned at its 27 s bound; set_opacity starts and hangs in turn.
    await vi.advanceTimersByTimeAsync(22_000);
    expect(await stuck).toBeInstanceOf(PluginToolFailure);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pingQueue(bridge)).toEqual({
      running: { method: 'set_opacity', runningMs: 2_000, figmaCalls: [] },
      waiting: 1,
      lastFailed: {
        method: 'set_fills',
        outcome: 'abandoned',
        figmaCalls: ['figma.getNodeByIdAsync(1:2)'],
        agoMs: 2_000,
      },
    });

    next.resolve('opacity');
    expect(await Promise.all(queued)).toEqual(['opacity', 'renamed']);
    expect(await pingQueue(bridge)).toEqual({
      running: null,
      waiting: 0,
      lastFailed: expect.objectContaining({ method: 'set_fills', outcome: 'abandoned' }),
    });
    bridge.dispose();
  });

  it('reports a write whose Figma call missed its deadline as the last failed write', async () => {
    const real = handlersFor(
      figmaWithHangingLookup({
        getNodeByIdAsync: async () => ({ id: '1:1', type: 'INSTANCE', swapComponent: () => {} }),
        importComponentByKeyAsync: () => new Promise(() => {}),
      }),
    );
    const bridge = freshBridge(real);

    const swap = bridge
      .handler('swap_component', { instanceId: '1:1', componentKey: 'key-abc' })
      .catch((error: unknown) => error);
    // The import's deadline is the 30 s budget less 10 s.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await swap).toBeInstanceOf(PluginToolFailure);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await pingQueue(bridge)).toEqual({
      running: null,
      waiting: 0,
      lastFailed: {
        method: 'swap_component',
        outcome: 'deadline',
        figmaCalls: ['importComponentByKeyAsync(key-abc)'],
        agoMs: 3_000,
      },
    });
    bridge.dispose();
  });

  it('fails a write that reaches its bound before it starts, naming the write that blocks it', async () => {
    const real = handlersFor(figmaWithHangingLookup());
    const setOpacity = vi.fn<SandboxToolHandler>(() => ({ ok: true }));
    const bridge = freshBridge({ ping: real.ping!, batch: real.batch!, set_opacity: setOpacity });

    // A one-op batch is bounded at 127 s (120 s + 10 s, less 3 s), so it is still running when the
    // write queued 10 s after it reaches its own 27 s bound.
    const batch = bridge
      .handler('batch', { ops: [{ tool: 'set_fills', params: { nodeId: '1:2', fills: RED } }] })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const blocked = bridge.handler('set_opacity', {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(26_999);
    expect(await pingQueue(bridge)).toEqual(expect.objectContaining({ waiting: 1 }));

    await vi.advanceTimersByTimeAsync(1);
    const error = await blocked;
    expect(error).toBeInstanceOf(PluginToolFailure);
    expect((error as PluginToolFailure).code).toBe('TIMEOUT');
    const message = (error as Error).message;
    expect(message).toContain('set_opacity did not start within 27 s');
    expect(message).toContain('batch, running for 37 s');
    expect(message).toContain('figma.getNodeByIdAsync(1:2)');
    expect(await pingQueue(bridge)).toEqual(
      expect.objectContaining({ running: expect.objectContaining({ method: 'batch' }), waiting: 0 }),
    );

    // The blocked write never runs, not even once the batch is out of the way.
    await vi.advanceTimersByTimeAsync(127_000);
    expect(await batch).toBeInstanceOf(PluginToolFailure);
    expect(setOpacity).not.toHaveBeenCalled();
    bridge.dispose();
  });
});
