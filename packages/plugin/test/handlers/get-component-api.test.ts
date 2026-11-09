import type { GetComponentApiResult } from '@figwright/shared';
import { describe, expect, it, vi } from 'vitest';

import { createGetComponentApiHandler } from '../../src/handlers/get-component-api.js';
import { withInstanceIdLookup } from '../../src/node-lookup.js';
import { CONNECTION_ERROR } from '../read-retry-fake.js';

it.each(['success', 'twice', 'other'] as const)(
  'bounds required component API lookup: %s',
  async outcome => {
    vi.useFakeTimers();
    try {
      const lookup = vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValueOnce(new Error(outcome === 'other' ? 'denied' : CONNECTION_ERROR));
      if (outcome === 'twice') lookup.mockRejectedValueOnce(new Error(CONNECTION_ERROR));
      else lookup.mockResolvedValue(standalone);
      const ctx = withInstanceIdLookup(
        fakeFigma({ 'I:1': { ...instance, getMainComponentAsync: lookup } }),
      );
      const reading = Promise.resolve(createGetComponentApiHandler(ctx)({ nodeId: 'I:1' })).catch(
        error => error,
      );
      await vi.runAllTimersAsync();
      const out = await reading;
      const expected =
        outcome === 'success'
          ? {
              id: 'C:9',
              name: 'Card',
              properties: { 'On#0:0': { type: 'BOOLEAN', defaultValue: true } },
            }
          : {
              message: `getMainComponentAsync(I:1) failed: ${outcome === 'other' ? 'denied' : `${CONNECTION_ERROR} Read failed twice.`}`,
            };
      expect(out).toMatchObject(expected);
      expect(lookup).toHaveBeenCalledTimes(outcome === 'other' ? 1 : 2);
    } finally {
      vi.useRealTimers();
    }
  },
);

it('attributes a main-component rejection to the instance', async () => {
  const cause = new Error('unavailable');
  const node = {
    id: '1:2',
    type: 'INSTANCE',
    getMainComponentAsync: async () => {
      throw cause;
    },
  };
  const handler = createGetComponentApiHandler({
    getNodeByIdAsync: async () => node,
  } as unknown as typeof figma);
  const error = await Promise.resolve(handler({ nodeId: '1:2' })).catch(e => e);
  expect(error).toMatchObject({ message: 'getMainComponentAsync(1:2) failed: unavailable', cause });
});

const defs = {
  Size: { type: 'VARIANT', defaultValue: 'md', variantOptions: ['sm', 'md', 'lg'] },
  'Disabled#1:2': { type: 'BOOLEAN', defaultValue: false },
  'Label#2:0': { type: 'TEXT', defaultValue: 'Button', description: 'Visible text' },
  'Icon#3:1': {
    type: 'INSTANCE_SWAP',
    defaultValue: '12:3',
    preferredValues: [{ type: 'COMPONENT', key: 'k1' }],
  },
};

const set = {
  id: 'CS:1',
  name: 'Button',
  type: 'COMPONENT_SET',
  parent: { id: 'P:0', type: 'PAGE' },
  componentPropertyDefinitions: defs,
};
// A variant component lives inside the set; the resolver climbs to the set for complete options.
const variant = { id: 'C:1', name: 'Size=md', type: 'COMPONENT', parent: set };
const standalone = {
  id: 'C:9',
  name: 'Card',
  type: 'COMPONENT',
  parent: { id: 'P:0', type: 'PAGE' },
  componentPropertyDefinitions: { 'On#0:0': { type: 'BOOLEAN', defaultValue: true } },
};
const instance = {
  id: 'I:1',
  name: 'Button instance',
  type: 'INSTANCE',
  getMainComponentAsync: async () => variant,
};

const fakeFigma = (lookup: Record<string, unknown>): typeof figma =>
  ({ getNodeByIdAsync: async (id: string) => lookup[id] ?? null }) as unknown as typeof figma;

describe('get_component_api handler', () => {
  it('returns a component set property API keyed verbatim', async () => {
    const result = (await createGetComponentApiHandler(fakeFigma({ 'CS:1': set }))({
      nodeId: 'CS:1',
    })) as GetComponentApiResult;
    expect(result).toMatchObject({ id: 'CS:1', name: 'Button', type: 'COMPONENT_SET' });
    expect(result.properties.Size).toEqual({
      type: 'VARIANT',
      defaultValue: 'md',
      variantOptions: ['sm', 'md', 'lg'],
    });
    expect(result.properties['Disabled#1:2']).toEqual({ type: 'BOOLEAN', defaultValue: false });
    expect(result.properties['Label#2:0']).toMatchObject({
      type: 'TEXT',
      description: 'Visible text',
    });
    expect(result.properties['Icon#3:1']?.preferredValues).toEqual([
      { type: 'COMPONENT', key: 'k1' },
    ]);
  });

  it('climbs a variant component to its set', async () => {
    const result = (await createGetComponentApiHandler(fakeFigma({ 'C:1': variant }))({
      nodeId: 'C:1',
    })) as GetComponentApiResult;
    expect(result.id).toBe('CS:1');
    expect(Object.keys(result.properties)).toContain('Size');
  });

  it('reads a standalone component as-is', async () => {
    const result = (await createGetComponentApiHandler(fakeFigma({ 'C:9': standalone }))({
      nodeId: 'C:9',
    })) as GetComponentApiResult;
    expect(result.id).toBe('C:9');
    expect(result.properties['On#0:0']).toEqual({ type: 'BOOLEAN', defaultValue: true });
  });

  it('resolves an instance to its main component / set', async () => {
    const result = (await createGetComponentApiHandler(fakeFigma({ 'I:1': instance }))({
      nodeId: 'I:1',
    })) as GetComponentApiResult;
    expect(result.id).toBe('CS:1');
  });

  it('throws for a non-component node and a missing node', async () => {
    const frame = { id: 'F:1', name: 'Frame', type: 'FRAME' };
    await expect(
      createGetComponentApiHandler(fakeFigma({ 'F:1': frame }))({ nodeId: 'F:1' }),
    ).rejects.toThrow(/not a component/);
    await expect(createGetComponentApiHandler(fakeFigma({}))({ nodeId: 'X:9' })).rejects.toThrow(
      /not found/,
    );
  });
});
