import { DEFAULT_TOOL_BUDGET_MS, ErrorCode, HEAVY_TOOL_BUDGET_MS } from '@figwright/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  createToolError,
  createToolResult,
  isPluginBridgeMessage,
  type PluginBridgeMessage,
  PluginToolFailure,
} from '../../protocol/bridge.js';
import { dispatchSandboxMessage } from '../../src/dispatcher.js';
import { createBatchHandler } from '../../src/handlers/batch.js';
import { createIdempotencyCache, idempotent } from '../../src/idempotency.js';
import {
  createToolBridge,
  type PostMessageFn,
  type SubscribeFn,
} from '../../ui/sandbox/tool-bridge.js';

interface Harness {
  bridge: ReturnType<typeof createToolBridge>;
  sent: PluginBridgeMessage[];
  emit: (raw: unknown) => void;
}

const setup = (timeoutMs?: number): Harness => {
  const sent: PluginBridgeMessage[] = [];
  const emitter: { current: ((raw: unknown) => void) | null } = { current: null };
  const postMessage: PostMessageFn = msg => sent.push(msg);
  const subscribe: SubscribeFn = cb => {
    emitter.current = cb;
    return () => {
      emitter.current = null;
    };
  };
  const bridge = createToolBridge({
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    postMessage,
    subscribe,
  });
  return {
    bridge,
    sent,
    emit: raw => emitter.current?.(raw),
  };
};

describe('createToolBridge', () => {
  it('reports progress when a stop for time exhausts the rollback reserve', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { bridge, sent, emit } = setup();
    let releaseApply!: () => void;
    let releaseUndo!: () => void;
    let markApply!: () => void;
    let markUndo!: () => void;
    const applyPending = new Promise<void>(resolve => {
      releaseApply = resolve;
    });
    const undoPending = new Promise<void>(resolve => {
      releaseUndo = resolve;
    });
    const applyStarted = new Promise<void>(resolve => {
      markApply = resolve;
    });
    const undoStarted = new Promise<void>(resolve => {
      markUndo = resolve;
    });
    try {
      const nodes = new Map(['1:1', '1:2', '1:3'].map(id => [id, { id, name: 'before' }]));
      let rollingBack = false;
      const figmaCtx = {
        root: { children: [] },
        getNodeByIdAsync: async (id: string) => {
          if (rollingBack && id === '1:1') {
            markUndo();
            await undoPending;
          }
          return nodes.get(id) ?? null;
        },
      } as unknown as typeof figma;
      const applied: string[] = [];
      const handler = createBatchHandler(figmaCtx, {
        rename_node: async params => {
          const p = params as { nodeId: string; name: string };
          nodes.get(p.nodeId)!.name = p.name;
          applied.push(p.nodeId);
          if (applied.length === 2) {
            markApply();
            await applyPending;
          }
          return { ok: true };
        },
      });
      const answer = bridge
        .handler('batch', {
          ops: [...nodes.keys()].map(nodeId => ({
            tool: 'rename_node',
            params: { nodeId, name: 'after' },
          })),
        })
        .catch(error => error);
      const sandbox = dispatchSandboxMessage({
        raw: sent[0],
        handlers: { batch: handler },
        editorType: 'figma',
        progress: state => {
          rollingBack = state.phase === 'rollback';
          emit(state);
        },
      });
      await applyStarted;
      await vi.advanceTimersByTimeAsync(90_001);
      releaseApply();
      await undoStarted;
      expect(applied).toEqual(['1:1', '1:2']);
      expect(nodes.get('1:2')!.name).toBe('before');
      await vi.advanceTimersByTimeAsync(59_999);
      expect(((await answer) as Error).message).toMatch(
        /phase=rollback.*completed op indexes=\[0, 1\].*in-flight op indexes=\[0\].*rolled-back op indexes=\[1\]/,
      );
      releaseUndo();
      const outcome = await sandbox;
      expect(outcome).toMatchObject({
        kind: 'reply',
        reply: {
          kind: 'tool-error',
          message: expect.stringMatching(/stopped for time after op 1.*rolled back 2 applied op/),
        },
      });
      if (outcome.kind === 'reply') emit(outcome.reply);
      expect(nodes.get('1:1')!.name).toBe('before');
      expect(nodes.get('1:3')!.name).toBe('before');
      expect(bridge.pendingCount()).toBe(0);
    } finally {
      releaseApply();
      releaseUndo();
      bridge.dispose();
      vi.useRealTimers();
    }
  });
  it.each(['capture', 'apply', 'rollback'])(
    'reports unknown batch outcome with %s progress and ignores expired traffic',
    async phase => {
      vi.useFakeTimers();
      const { bridge, sent, emit } = setup(20);
      try {
        const answer = bridge.handler('batch', { ops: [{}, {}, {}] }).catch(error => error);
        const progress = {
          tag: '@figwright/bridge',
          kind: 'tool-progress',
          id: sent[0]!.id,
          phase,
          completed: phase === 'capture' ? [] : [0, 1],
          inFlight: [2],
          rolledBack: [],
        };
        emit(progress);
        expect(bridge.pendingCount()).toBe(1); // Progress must not complete or extend the call.
        await vi.advanceTimersByTimeAsync(20);
        const error = (await answer) as Error;
        expect(error).toMatchObject({ code: ErrorCode.Timeout });
        expect(error.message).toContain('outcome is unknown');
        expect(error.message).toContain(`phase=${phase}`);
        expect(error.message).toContain(
          `completed op indexes=[${phase === 'capture' ? '' : '0, 1'}]`,
        );
        expect(error.message).toContain('in-flight op indexes=[2]');
        expect(error.message).toMatch(/read back the targets before any retry/i);
        emit({ ...progress, completed: [0, 1, 2], inFlight: [] });
        emit(createToolResult({ id: sent[0]!.id, result: { ok: true } }));
        expect(bridge.pendingCount()).toBe(0);
        const retry = bridge.handler('ping', {});
        emit(progress);
        expect(bridge.pendingCount()).toBe(1);
        emit(createToolResult({ id: sent[1]!.id, result: 'independent' }));
        await expect(retry).resolves.toBe('independent');
        expect(error.message).toContain('in-flight op indexes=[2]');
      } finally {
        bridge.dispose();
        vi.useRealTimers();
      }
    },
  );

  it('reports unknown progress when no sandbox progress arrived', async () => {
    vi.useFakeTimers();
    const { bridge } = setup(20);
    try {
      const answer = bridge.handler('batch', { ops: [{}] }).catch(error => error);
      await vi.advanceTimersByTimeAsync(20);
      expect(((await answer) as Error).message).toMatch(/outcome is unknown.*progress unavailable/);
    } finally {
      bridge.dispose();
      vi.useRealTimers();
    }
  });

  it.each(['capture', 'apply', 'rollback'])(
    'carries real %s progress through the dispatcher and idempotency wrapper',
    async phase => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const { bridge, sent, emit } = setup(20);
      try {
        const node = { id: '1:1', name: 'before' };
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>(resolve => {
          markStarted = resolve;
        });
        const released = new Promise<void>(resolve => {
          release = resolve;
        });
        let rollingBack = false;
        const figmaCtx = {
          root: { children: [] },
          getNodeByIdAsync: async () => {
            if (phase === 'capture' || rollingBack) {
              markStarted();
              await released;
            }
            return node;
          },
        } as unknown as typeof figma;
        let applied = 0;
        const cache = createIdempotencyCache();
        const batch = idempotent(
          cache,
          createBatchHandler(figmaCtx, {
            rename_node: async () => {
              if (++applied === 2) {
                if (phase === 'apply') {
                  markStarted();
                  await released;
                }
                if (phase === 'rollback') {
                  rollingBack = true;
                  throw new Error('apply blocked');
                }
              }
              node.name = 'after';
              return { ok: true };
            },
          }),
        );
        const answer = bridge
          .handler('batch', {
            requestId: 'logical-call',
            ops: [0, 1].map(() => ({
              tool: 'rename_node',
              params: { nodeId: '1:1', name: 'after' },
            })),
          })
          .catch(error => error);
        const sandbox = dispatchSandboxMessage({
          raw: sent[0],
          handlers: { batch },
          editorType: 'figma',
          progress: emit,
        });
        await started;
        expect(cache.size()).toBe(0);
        await vi.advanceTimersByTimeAsync(20);
        const error = (await answer) as Error;
        expect(error.message).toContain(`phase=${phase}`);
        expect(error.message).toContain(`completed op indexes=[${phase === 'capture' ? '' : '0'}]`);
        expect(error.message).toContain(
          `in-flight op indexes=[${phase === 'capture' ? '0, 1' : phase === 'apply' ? '1' : '0'}]`,
        );
        release();
        const outcome = await sandbox;
        if (outcome.kind === 'reply') emit(outcome.reply);
        expect(cache.size()).toBe(phase === 'rollback' ? 0 : 1);
        expect(bridge.pendingCount()).toBe(0);
      } finally {
        bridge.dispose();
        vi.useRealTimers();
      }
    },
  );
  it.each([
    [1, 130_000],
    [12, 240_000],
    [100, 600_000],
  ])('uses the batch budget for %i ops', async (count, budget) => {
    vi.useFakeTimers();
    const { bridge } = setup();
    try {
      const answer = bridge
        .handler('batch', { ops: Array.from({ length: count }, () => ({})) })
        .catch(error => error);
      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(bridge.pendingCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await answer).toBeInstanceOf(Error);
      expect(bridge.pendingCount()).toBe(0);
    } finally {
      bridge.dispose();
      vi.useRealTimers();
    }
  });
  it('posts a tagged tool-call when handler is invoked', async () => {
    const { bridge, sent, emit } = setup();
    const promise = bridge.handler('ping', { foo: 1 });
    expect(sent).toHaveLength(1);
    expect(isPluginBridgeMessage(sent[0])).toBe(true);
    expect(sent[0]).toMatchObject({
      kind: 'tool-call',
      method: 'ping',
      params: { foo: 1 },
    });
    emit(createToolResult({ id: sent[0]!.id, result: { pong: true } }));
    await expect(promise).resolves.toEqual({ pong: true });
    expect(bridge.pendingCount()).toBe(0);
  });

  // The code stays a field instead of being folded into the message. It used to reject with
  // `${code}: ${message}`, which left the relay client unable to recover the code — it sent a
  // hardcoded Internal alongside a message that already named the real one, and the server prefixed
  // it a second time. Asserting the concatenation here is what made that shape look intended.
  it('rejects when sandbox replies with tool-error, keeping the code addressable', async () => {
    const { bridge, sent, emit } = setup();
    const promise = bridge.handler('ping', undefined);
    emit(createToolError({ id: sent[0]!.id, code: 'BOOM', message: 'sandbox failed' }));
    await expect(promise).rejects.toThrow(PluginToolFailure);
    await expect(promise).rejects.toMatchObject({ code: 'BOOM', message: 'sandbox failed' });
    expect(bridge.pendingCount()).toBe(0);
  });

  it('times out when sandbox never replies', async () => {
    const { bridge } = setup(20);
    await expect(bridge.handler('ping', undefined)).rejects.toThrow(/timeout/);
  });

  it.each(['import_variable', 'import_style'])(
    'reports a %s timeout with a foreground retry path without closing the bridge',
    async method => {
      vi.useFakeTimers();
      const { bridge, sent, emit } = setup();
      try {
        const answer = bridge.handler(method, {}).then(
          result => ({ result }),
          error => ({ error }),
        );
        // Still pending past the default window: a background import gets the heavy one.
        await vi.advanceTimersByTimeAsync(DEFAULT_TOOL_BUDGET_MS + 1);
        expect(bridge.pendingCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(HEAVY_TOOL_BUDGET_MS - DEFAULT_TOOL_BUDGET_MS);
        await expect(answer).resolves.toMatchObject({
          error: {
            code: ErrorCode.Timeout,
            message: expect.stringMatching(/target Figma file.*foreground.*retry/),
          },
        });
        expect(bridge.pendingCount()).toBe(0);

        // Timing out abandons the reply, not Figma's pending import. A late result must not
        // resurrect the call or prevent an independent foreground retry from succeeding.
        emit(createToolResult({ id: sent[0]!.id, result: { ok: true } }));
        const retry = bridge.handler(method, {});
        emit(createToolResult({ id: sent[1]!.id, result: { ok: true } }));
        await expect(retry).resolves.toEqual({ ok: true });
        expect(bridge.pendingCount()).toBe(0);
      } finally {
        bridge.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(['search_nodes', 'scan_nodes_by_types', 'scan_text_nodes', 'get_local_components'])(
    'keeps a large %s pending past the default window and accepts its result',
    async method => {
      vi.useFakeTimers();
      const { bridge, sent, emit } = setup();
      try {
        const promise = bridge.handler(method, {});
        // Observe rejections immediately, including when a too-short budget fires mid-advance.
        const answer = promise.then(
          result => ({ result }),
          error => ({ error }),
        );
        await vi.advanceTimersByTimeAsync(DEFAULT_TOOL_BUDGET_MS + 1);
        emit(createToolResult({ id: sent[0]!.id, result: { nodes: [] } }));
        await expect(answer).resolves.toEqual({ result: { nodes: [] } });
        expect(bridge.pendingCount()).toBe(0);
      } finally {
        bridge.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(['search_nodes', 'scan_nodes_by_types', 'scan_text_nodes', 'get_local_components'])(
    'still times out %s when it never answers within the heavy budget',
    async method => {
      vi.useFakeTimers();
      const { bridge } = setup();
      try {
        const promise = bridge.handler(method, {});
        const answer = promise.then(
          result => ({ result }),
          error => ({ error }),
        );
        await vi.advanceTimersByTimeAsync(HEAVY_TOOL_BUDGET_MS);
        await expect(answer).resolves.toEqual({
          error: new Error(`sandbox tool timeout (method=${method})`),
        });
        expect(bridge.pendingCount()).toBe(0);
      } finally {
        bridge.dispose();
        vi.useRealTimers();
      }
    },
  );

  it('ignores orphan replies for unknown ids', async () => {
    const log = vi.fn<(msg: string) => void>();
    const emitter: { current: ((raw: unknown) => void) | null } = { current: null };
    const bridge = createToolBridge({
      log,
      postMessage: () => {},
      subscribe: cb => {
        emitter.current = cb;
        return () => {
          emitter.current = null;
        };
      },
    });
    emitter.current?.(createToolResult({ id: 'never-sent', result: 1 }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('orphan'));
    bridge.dispose();
  });

  it('ignores non-bridge messages (e.g. Figma internals)', () => {
    const { emit } = setup();
    emit({ pluginMessage: 'something else' });
    emit(undefined);
    emit({ tag: 'wrong', kind: 'tool-result', id: 'x' });
    // nothing to assert beyond no throw
    expect(true).toBe(true);
  });

  it('dispose rejects pending and unsubscribes', async () => {
    const { bridge } = setup();
    const promise = bridge.handler('ping', undefined);
    bridge.dispose();
    await expect(promise).rejects.toThrow(/disposed/);
    expect(bridge.pendingCount()).toBe(0);
  });
});
