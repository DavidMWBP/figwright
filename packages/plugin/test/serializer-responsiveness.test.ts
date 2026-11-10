import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetThrottleForTests } from '../src/cooperative.js';
import { withInstanceIdLookup } from '../src/node-lookup.js';
import { serializeFlatNodes, serializeTrees } from '../src/serializer.js';
import { CONNECTION_ERROR } from './read-retry-fake.js';

describe('native-read time slicing', () => {
  beforeEach(() => {
    resetThrottleForTests();
  });

  it.each([
    ['flat', serializeFlatNodes],
    ['forest', serializeTrees],
  ] as const)(
    'keeps later %s lookups progressing and output ordered while a component read retries',
    async (_kind, serialize) => {
      vi.useFakeTimers();
      try {
        let rejectFirst!: (error: Error) => void;
        const first = new Promise<never>((_resolve, reject) => {
          rejectFirst = reject;
        });
        let resolveLater!: () => void;
        const later = new Promise<void>(resolve => {
          resolveLater = resolve;
        });
        const lookup = vi
          .fn<() => Promise<unknown>>()
          .mockImplementationOnce(() => first)
          .mockResolvedValue({ id: 'main:0', name: 'First', key: 'first' });
        const nodes = [
          lookup,
          async () => {
            resolveLater();
            return { id: 'main:1', name: 'Later', key: 'later' };
          },
        ].map(
          (getMainComponentAsync, i) =>
            ({
              id: `instance:${i}`,
              name: 'Instance',
              type: 'INSTANCE',
              visible: true,
              locked: false,
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              parent: null,
              getMainComponentAsync,
            }) as unknown as SceneNode,
        );
        const reading = serialize(nodes, null, withInstanceIdLookup({} as typeof figma));
        await later;
        rejectFirst(new Error(CONNECTION_ERROR));
        await vi.runAllTimersAsync();
        const out = await reading;
        expect(out.complete).toBe(true);
        expect(out.nodes.map(node => [node.id, node.mainComponent?.id])).toEqual([
          ['instance:0', 'main:0'],
          ['instance:1', 'main:1'],
        ]);
        expect(lookup).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ['flat', serializeFlatNodes],
    ['forest', serializeTrees],
  ] as const)(
    'lets the host run during expensive %s reads below the batch size',
    async (_kind, serialize) => {
      let elapsed = 0;
      let reads = 0;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsed);
      const nodes = Array.from({ length: 32 }, (_, index) => {
        const node = {
          id: `2:${index}`,
          name: `Instance ${index}`,
          type: 'INSTANCE',
          visible: true,
          locked: false,
          x: 0,
          y: 0,
          get width() {
            reads += 1;
            elapsed += 20;
            return 10;
          },
          height: 10,
          parent: null,
          getMainComponentAsync: async () => ({
            id: `3:${index}`,
            name: `Main ${index}`,
            key: `key-${index}`,
            parent: null,
          }),
        };
        return node as unknown as SceneNode;
      });
      const hostTick = new Promise<number>(resolve => setTimeout(() => resolve(reads), 0));
      try {
        const result = await serialize(nodes);
        expect(await hostTick).toBeLessThan(nodes.length);
        expect(result.complete).toBe(true);
        expect(result.nodes.map(node => node.id)).toEqual(nodes.map(node => node.id));
        expect(result.nodes.map(node => node.mainComponent?.id)).toEqual(
          nodes.map((_, index) => `3:${index}`),
        );
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([
    ['flat', serializeFlatNodes],
    ['forest', serializeTrees],
  ] as const)('propagates native read errors across %s host yields', async (_kind, serialize) => {
    const failure = new Error('native read failed');
    let elapsed = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsed);
    const nodes = Array.from(
      { length: 4 },
      (_, index) =>
        ({
          id: `2:${index}`,
          name: `Node ${index}`,
          type: 'RECTANGLE',
          visible: true,
          locked: false,
          x: 0,
          y: 0,
          get width() {
            elapsed += 20;
            if (index === 0) throw failure;
            return 10;
          },
          height: 10,
          parent: null,
        }) as unknown as SceneNode,
    );
    try {
      // The rejection names the failing node and its read stage, and keeps the native error as the cause.
      const error = await serialize(nodes).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe(failure);
      expect((error as Error).message).toContain(
        'native read failed (node 2:0 "Node 0", read stage: native fields)',
      );
    } finally {
      clock.mockRestore();
    }
  });
});
