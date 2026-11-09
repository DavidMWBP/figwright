import type { GetNodeResult } from '@figwright/shared';
import { describe, expect, it, vi } from 'vitest';

import { createGetNodeHandler } from '../../src/handlers/get-node.js';
import { createSandboxHandlers } from '../../src/handlers/registry.js';
import { CONNECTION_ERROR } from '../read-retry-fake.js';

const fake = (overrides: Record<string, unknown> = {}): SceneNode =>
  ({
    id: '1:2',
    name: 'Node',
    type: 'RECTANGLE',
    visible: true,
    locked: false,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    parent: { id: '1:1' },
    ...overrides,
  }) as unknown as SceneNode;

const fakeFigma = (lookup: Record<string, BaseNode | null>): typeof figma =>
  ({
    getNodeByIdAsync: async (id: string) => lookup[id] ?? null,
  }) as unknown as typeof figma;

describe('get_node handler', () => {
  it.each(['width', 'children'] as const)(
    'attributes a failing %s read and preserves its cause without retrying',
    async field => {
      const cause = new Error('Attempted to invoke callback with invalid id');
      const node = fake({ type: 'FRAME', name: 'Broken' });
      const getter = vi.fn<() => never>(() => {
        throw cause;
      });
      Object.defineProperty(node, field, { get: getter });
      const lookup = vi.fn<(id: string) => Promise<BaseNode | null>>(async id =>
        id === '0:1' ? ({ id } as BaseNode) : node,
      );
      const handler = createSandboxHandlers({
        currentPage: { id: '0:1' },
        getNodeByIdAsync: lookup,
      } as unknown as typeof figma).get_node!;
      const error = await Promise.resolve(handler({ nodeId: '1:2' })).catch(failure => failure);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('Expected a rejected Error');
      expect(error.cause).toBe(cause);
      expect(error.message).toContain(
        'serializeNode(1:2) failed: Attempted to invoke callback with invalid id',
      );
      expect(error.message).toContain(
        `read stage: ${field === 'children' ? 'children' : 'native fields'}`,
      );
      expect(error.message).toContain('Broken');
      expect(error.message).toContain('current page still answers');
      expect(lookup.mock.calls).toEqual([['1:2'], ['0:1']]);
      expect(getter).toHaveBeenCalledOnce();
    },
  );

  it('keeps the native failure when the node name is unreadable', async () => {
    const cause = new Error('name unavailable');
    const node = fake();
    Object.defineProperty(node, 'name', {
      get: () => {
        throw cause;
      },
    });
    await expect(
      createGetNodeHandler(fakeFigma({ '1:2': node }))({ nodeId: '1:2' }),
    ).rejects.toMatchObject({
      cause,
      message: expect.stringContaining('serializeNode(1:2) failed: name unavailable'),
      nodeId: '1:2',
      stage: 'native fields',
    });
  });

  it('names the requested id when the root id getter fails', async () => {
    const cause = new Error('Attempted to invoke callback with invalid id');
    const node = fake({ name: 'Broken' });
    Object.defineProperty(node, 'id', {
      get: () => {
        throw cause;
      },
    });
    await expect(
      createGetNodeHandler(fakeFigma({ '1:2': node }))({ nodeId: '1:2' }),
    ).rejects.toMatchObject({
      cause,
      message: expect.stringContaining(
        'serializeNode(1:2) failed: Attempted to invoke callback with invalid id (node 1:2 "Broken", read stage: native fields)',
      ),
      nodeId: '1:2',
      stage: 'native fields',
    });
  });

  it('reports a failed page probe and refreshes it on the next serialization invocation', async () => {
    const node = fake();
    Object.defineProperty(node, 'width', {
      get: () => {
        throw new Error('native read rejected');
      },
    });
    const lookup = vi.fn<(id: string) => Promise<BaseNode | null>>(async id => {
      if (id === '0:1') throw new Error('health rejected');
      return node;
    });
    const handler = createSandboxHandlers({
      currentPage: { id: '0:1' },
      getNodeByIdAsync: lookup,
    } as unknown as typeof figma).get_node!;
    for (let i = 0; i < 2; i++) {
      await expect(handler({ nodeId: '1:2' })).rejects.toThrow(
        'loaded-page health probe failed too',
      );
    }
    expect(lookup.mock.calls).toEqual([['1:2'], ['0:1'], ['1:2'], ['0:1']]);
  });

  it('keeps a rejected target as an error and probes again on the next tool call', async () => {
    const lookup = vi.fn<(id: string) => Promise<BaseNode | null>>(async id => {
      if (id === '0:1') return { id } as BaseNode;
      throw new Error('lookup rejected');
    });
    const handlers = createSandboxHandlers({
      currentPage: { id: '0:1' },
      getNodeByIdAsync: lookup,
    } as unknown as typeof figma);
    for (let i = 0; i < 2; i++) {
      await expect(handlers.get_node!({ nodeId: '8:8' })).rejects.toThrow(
        'session answered other reads',
      );
    }
    expect(lookup.mock.calls.filter(([id]) => id === '0:1')).toHaveLength(2);
    await expect(
      handlers.rename_node!({ nodeId: '8:8', name: 'After', requestId: 'failed-write' }),
    ).rejects.toThrow('reload is not indicated');
  });
  it('retries a connection rejection once and returns the node', async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi
        .fn<(id: string) => Promise<BaseNode | null>>()
        .mockRejectedValueOnce(CONNECTION_ERROR)
        .mockResolvedValue(fake());
      const reading = Promise.resolve(
        createSandboxHandlers({ getNodeByIdAsync: lookup } as unknown as typeof figma).get_node!({
          nodeId: '1:2',
        }),
      ).catch(error => error);
      await vi.runAllTimersAsync();
      expect(await reading).toMatchObject({ node: { id: '1:2' } });
      expect(lookup.mock.calls).toEqual([['1:2'], ['1:2']]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('throws when nodeId is missing or not a string', async () => {
    const handler = createGetNodeHandler(fakeFigma({}));
    await expect(handler(undefined)).rejects.toThrow(/nodeId/);
    await expect(handler({ nodeId: 123 })).rejects.toThrow(/nodeId/);
  });

  it('returns { node: null } when not found', async () => {
    const handler = createGetNodeHandler(fakeFigma({ '1:99': null }));
    const result = await handler({ nodeId: '1:99' });
    expect(result).toEqual({ node: null });
  });

  it('serializes a SceneNode subtree (含 children)', async () => {
    const child = fake({ id: '1:3', parent: { id: '1:2' } });
    const node = fake({ id: '1:2', type: 'FRAME', children: [child] });
    const handler = createGetNodeHandler(fakeFigma({ '1:2': node as unknown as BaseNode }));
    const result = (await handler({ nodeId: '1:2' })) as GetNodeResult;
    expect(result.node?.id).toBe('1:2');
    expect(result.node?.children?.[0]?.id).toBe('1:3');
  });

  it('returns null when target is DOCUMENT or PAGE', async () => {
    const pageNode = { id: 'p-1', type: 'PAGE' } as unknown as BaseNode;
    const docNode = { id: 'doc-1', type: 'DOCUMENT' } as unknown as BaseNode;
    const handler = createGetNodeHandler(fakeFigma({ 'p-1': pageNode, 'doc-1': docNode }));
    expect(await handler({ nodeId: 'p-1' })).toEqual({ node: null });
    expect(await handler({ nodeId: 'doc-1' })).toEqual({ node: null });
  });
});
