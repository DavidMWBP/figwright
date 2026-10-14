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
