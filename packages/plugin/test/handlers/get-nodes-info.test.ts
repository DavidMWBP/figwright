import type { GetNodesInfoResult } from '@figwright/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGetNodesInfoHandler } from '../../src/handlers/get-nodes-info.js';
import { createSandboxHandlers } from '../../src/handlers/registry.js';
import { withInstanceIdLookup } from '../../src/node-lookup.js';
import { CONNECTION_ERROR } from '../read-retry-fake.js';

const timeout =
  'Unable to establish connection to Figma after 10 seconds. Please check your internet connection.';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const rejectingHandler = () => {
  const handler = createGetNodesInfoHandler(
    withInstanceIdLookup({
      getNodeByIdAsync: async (id: string) => {
        if (id === '1:3') return null;
        if (id === '1:2' || id === '1:4') return fake({ id });
        throw timeout; // eslint-disable-line no-throw-literal
      },
    } as unknown as typeof figma),
  );
  return async (params: unknown): Promise<unknown> => {
    const reading = Promise.resolve(handler(params));
    const observed = reading.catch(error => error);
    await vi.runAllTimersAsync();
    await observed;
    return reading;
  };
};

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

describe('get_nodes_info handler', () => {
  it.each([
    ['1:2', '8:8', '1:4'],
    ['8:8', '8:9', '8:8'],
  ])('probes once for a multi-id call: %j', async (...nodeIds) => {
    const lookup = vi.fn<(id: string) => Promise<BaseNode | null>>(async id => {
      if (id === '0:1') return { id, type: 'PAGE' } as BaseNode;
      if (id.startsWith('8:')) throw new Error('target rejected');
      return fake({ id });
    });
    const result = (await createSandboxHandlers({
      currentPage: { id: '0:1' },
      getNodeByIdAsync: lookup,
    } as unknown as typeof figma).get_nodes_info!({ nodeIds })) as GetNodesInfoResult;
    expect(result.nodes.map(n => n?.id ?? null)).toEqual(
      nodeIds.map(id => (id.startsWith('8:') ? null : id)),
    );
    const message = expect.stringContaining('session answered other reads');
    expect(result.lookupErrors).toEqual(
      nodeIds.flatMap((nodeId, index) =>
        nodeId.startsWith('8:') ? [{ index, nodeId, message }] : [],
      ),
    );
    expect(lookup.mock.calls.filter(([id]) => id === '0:1')).toHaveLength(1);
  });
  it('caps retries across twenty failing ids and resets the cap for the next call', async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi
        .fn<(id: string) => Promise<BaseNode | null>>()
        .mockRejectedValue(CONNECTION_ERROR);
      const handler = createSandboxHandlers({
        getNodeByIdAsync: lookup,
      } as unknown as typeof figma).get_nodes_info!;
      const ids = Array.from({ length: 20 }, (_, i) => `1:${i}`);
      for (const calls of [23, 46]) {
        const reading = Promise.resolve(handler({ nodeIds: ids })).catch(error => error);
        await vi.runAllTimersAsync();
        const result = (await reading) as GetNodesInfoResult;
        expect(result.nodes).toEqual(ids.map(() => null));
        expect(result.lookupErrors).toHaveLength(20);
        expect(result.lookupErrors?.some(error => /retry cap reached/i.test(error.message))).toBe(
          true,
        );
        expect(lookup).toHaveBeenCalledTimes(calls);
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps other results when one lookup rejects', async () => {
    const result = (await rejectingHandler()({
      nodeIds: ['1:4', '8:8', '1:2'],
    })) as GetNodesInfoResult;
    expect(result.nodes.map(n => n?.id ?? null)).toEqual(['1:4', null, '1:2']);
    expect(result).toMatchObject({
      lookupErrors: [{ index: 1, nodeId: '8:8', message: expect.stringContaining(timeout) }],
    });
  });

  it('distinguishes a missing id from a rejected lookup', async () => {
    const result = (await rejectingHandler()({ nodeIds: ['1:3', '8:8'] })) as GetNodesInfoResult;
    expect(result.nodes).toEqual([null, null]);
    expect(result).toMatchObject({ lookupErrors: [{ index: 1, nodeId: '8:8' }] });
    expect(result.lookupErrors).toHaveLength(1);
  });

  it.each([{ nodeIds: ['8:8'] }, { nodeIds: ['8:8', '8:9'] }])(
    'keeps every error slot when every id rejects: $nodeIds',
    async ({ nodeIds }) => {
      const result = (await rejectingHandler()({ nodeIds })) as GetNodesInfoResult;
      expect(result.nodes).toEqual(nodeIds.map(() => null));
      expect(result.lookupErrors).toEqual(
        nodeIds.map((nodeId, index) => ({
          index,
          nodeId,
          message: expect.stringContaining(timeout),
        })),
      );
    },
  );

  it('reports each rejected occurrence of a duplicate id', async () => {
    const result = (await rejectingHandler()({
      nodeIds: ['8:8', '1:2', '8:8'],
    })) as GetNodesInfoResult;
    expect(result.nodes.map(n => n?.id ?? null)).toEqual([null, '1:2', null]);
    expect(result).toMatchObject({
      lookupErrors: [
        { index: 0, nodeId: '8:8' },
        { index: 2, nodeId: '8:8' },
      ],
    });
  });

  it('returns the existing empty result for no ids', async () => {
    expect(await rejectingHandler()({ nodeIds: [] })).toEqual({ nodes: [] });
  });
  it('throws when nodeIds is not a string[]', async () => {
    const handler = createGetNodesInfoHandler(fakeFigma({}));
    await expect(handler({ nodeIds: 'not-array' })).rejects.toThrow(/string\[]/);
    await expect(handler({ nodeIds: [1, 2] })).rejects.toThrow(/string\[]/);
  });

  it('returns serialized nodes preserving input order with null for missing', async () => {
    const a = fake({ id: '1:2' });
    const c = fake({ id: '1:4' });
    const handler = createGetNodesInfoHandler(
      fakeFigma({ '1:2': a as unknown as BaseNode, '1:4': c as unknown as BaseNode }),
    );
    const result = (await handler({ nodeIds: ['1:2', '1:3', '1:4'] })) as GetNodesInfoResult;
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0]?.id).toBe('1:2');
    expect(result.nodes[1]).toBeNull();
    expect(result.nodes[2]?.id).toBe('1:4');
  });

  it('returns null slots for DOCUMENT / PAGE types', async () => {
    const pageNode = { id: 'p-1', type: 'PAGE' } as unknown as BaseNode;
    const handler = createGetNodesInfoHandler(fakeFigma({ 'p-1': pageNode }));
    const result = (await handler({ nodeIds: ['p-1'] })) as GetNodesInfoResult;
    expect(result.nodes).toEqual([null]);
  });

  // A frame of six children, each carrying a 1 MiB name: ~6 MiB serialized — one fits a result,
  // two do not.
  const wideFrame = (id: string): SceneNode =>
    fake({
      id,
      type: 'FRAME',
      children: Array.from({ length: 6 }, (_, i) =>
        fake({ id: `${id}-${i}`, name: 'x'.repeat(1024 * 1024) }),
      ),
    });

  it('returns trees that fit one result together, unchanged', async () => {
    const big = wideFrame('1:2');
    const small = fake({ id: '1:9' });
    const handler = createGetNodesInfoHandler(
      fakeFigma({ '1:2': big as unknown as BaseNode, '1:9': small as unknown as BaseNode }),
    );
    const result = (await handler({ nodeIds: ['1:2', '1:9'] })) as GetNodesInfoResult;
    expect(result.nodes.map(n => n?.id)).toEqual(['1:2', '1:9']);
    expect(result.nodes[0]?.children).toHaveLength(6);
  });

  it('refuses trees that fit one at a time but not together, naming each', async () => {
    const handler = createGetNodesInfoHandler(
      fakeFigma({
        '1:2': wideFrame('1:2') as unknown as BaseNode,
        '1:3': wideFrame('1:3') as unknown as BaseNode,
      }),
    );
    await expect(handler({ nodeIds: ['1:2', '1:3'] })).rejects.toThrow(
      /together serialize past 10\.0 MB .*\(1:2: 7 nodes, 1:3: 7 nodes\)/,
    );
  });
});
