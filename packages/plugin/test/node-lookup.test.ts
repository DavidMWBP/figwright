import type { GetNodeMotionResult, MutateResult } from '@figwright/shared';
import { describe, expect, it, vi } from 'vitest';

import { createSandboxHandlers } from '../src/handlers/registry.js';
import { withInstanceIdLookup } from '../src/node-lookup.js';
import { unloadedPage } from './page-fake.js';

it('registry page handlers bypass the proxied by-id lookup', async () => {
  const f = unloadedPage();
  f.getNodeByIdAsync.mockRejectedValue(new Error('lookup unavailable'));
  f.finish();
  const handlers = createSandboxHandlers(f.figmaCtx);
  const result = await Promise.resolve(
    handlers.rename_page!({ pageId: f.page.id, name: 'After' }),
  ).catch(error => error);
  expect(f.getNodeByIdAsync).not.toHaveBeenCalled();
  expect(result).toEqual({
    ok: true,
    nodeId: f.page.id,
  });
  expect(f.page.name).toBe('After');
});

// Figma's own rejection, measured live while the by-id lookup was timing out: a bare string, not an Error.
const BY_ID_TIMEOUT =
  'Unable to establish connection to Figma after 10 seconds. Please check your internet connection.';

interface FakeNode {
  id: string;
  name: string;
  visible: boolean;
  children?: FakeNode[];
  applyAnimationStyle: () => void;
  animationStyles: unknown[];
  animations: Record<string, unknown>;
  manualKeyframeTracks: Record<string, unknown>;
  timelines: { id: string; duration: number }[];
  findOne?: (cb: (n: FakeNode) => boolean) => FakeNode | null;
}

const node = (id: string, children?: FakeNode[], visible = true): FakeNode => {
  const n: FakeNode = {
    id,
    name: id,
    visible,
    applyAnimationStyle: () => {},
    animationStyles: [],
    // The id as a keyframe value, so a read proves which node it resolved to.
    animations: { OPACITY: { keyframes: [{ time: 0, value: id }] } },
    manualKeyframeTracks: {},
    timelines: [],
  };
  if (children !== undefined) {
    n.children = children;
    n.findOne = cb => {
      for (const child of children) {
        if (cb(child)) return child;
        const deeper = child.findOne?.(cb) ?? null;
        if (deeper !== null) return deeper;
      }
      return null;
    };
  }
  return n;
};

/**
 * A file whose by-id lookup either works (`healthy`) or rejects every instance-qualified id with
 * Figma's bare string while plain ids still resolve. Every call to the real lookup is recorded.
 */
const fakeFigma = (byId: 'healthy' | 'rejects-instance-ids') => {
  const hidden = node('I2:6;2:7', undefined, false);
  const nestedChild = node('I2:6;3:1;3:2');
  const sublayer = node('I2:6;2:5');
  const nested = node('I2:6;3:1', [nestedChild]);
  const instance = node('2:6', [sublayer, hidden, nested]);
  const frame = node('1:3', [instance]);
  const all = new Map<string, FakeNode>(
    [frame, instance, sublayer, hidden, nested, nestedChild].map(n => [n.id, n]),
  );
  const lookups: string[] = [];
  const figmaCtx = {
    editorType: 'figma',
    motion: {},
    skipInvisibleInstanceChildren: false,
    getNodeByIdAsync: async (id: string) => {
      lookups.push(id);
      if (byId === 'rejects-instance-ids' && id.startsWith('I')) throw BY_ID_TIMEOUT; // eslint-disable-line no-throw-literal
      return all.get(id) ?? null;
    },
  } as unknown as typeof figma;
  return { figmaCtx, lookups, sublayer, nestedChild };
};

describe('a healthy by-id lookup is used as is', () => {
  it('resolves an instance-qualified id through Figma, without walking the instance', async () => {
    const { figmaCtx, lookups, nestedChild } = fakeFigma('healthy');
    const ctx = withInstanceIdLookup(figmaCtx);
    expect(await ctx.getNodeByIdAsync('I2:6;3:1;3:2')).toBe(nestedChild);
    expect(await ctx.getNodeByIdAsync('I2:6;9:9')).toBeNull();
    expect(lookups).toEqual(['I2:6;3:1;3:2', 'I2:6;9:9']);
  });

  it('passes a plain id and null through unchanged', async () => {
    const { figmaCtx, lookups } = fakeFigma('rejects-instance-ids');
    const ctx = withInstanceIdLookup(figmaCtx);
    expect(await ctx.getNodeByIdAsync('999:999')).toBeNull();
    expect(await ctx.getNodeByIdAsync('1:3')).toBe(await figmaCtx.getNodeByIdAsync('1:3'));
    const rejecting = withInstanceIdLookup({
      getNodeByIdAsync: async () => Promise.reject(new Error('plain lookup failed')),
    } as unknown as typeof figma);
    await expect(rejecting.getNodeByIdAsync('1:3')).rejects.toThrow('plain lookup failed');
    expect(lookups).toEqual(['999:999', '1:3', '1:3']);
  });
});

describe('lookup rejection context', () => {
  it('probes only after the target retry is exhausted, without retrying a failed probe', async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi
        .fn<(id: string) => Promise<BaseNode | null>>()
        .mockRejectedValue(BY_ID_TIMEOUT);
      const reading = withInstanceIdLookup({
        currentPage: { id: '0:1' },
        getNodeByIdAsync: lookup,
      } as unknown as typeof figma)
        .getNodeByIdAsync('8:8')
        .catch(error => error);
      await vi.runAllTimersAsync();
      expect((await reading).message).toContain('Reload the plugin');
      expect(lookup.mock.calls).toEqual([['8:8'], ['8:8'], ['0:1']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a probe resolving null as a failed health check', async () => {
    const lookup = vi.fn<(id: string) => Promise<BaseNode | null>>(async id => {
      if (id === '0:1') return null;
      throw new Error('target failed');
    });
    const ctx = withInstanceIdLookup({
      currentPage: { id: '0:1' },
      getNodeByIdAsync: lookup,
    } as unknown as typeof figma);
    await expect(ctx.getNodeByIdAsync('8:8')).rejects.toThrow('session is not answering reads');
    expect(lookup.mock.calls).toEqual([['8:8'], ['0:1']]);
  });
  it.each([true, false])(
    'probes a loaded page once and attributes failures (healthy=%s)',
    async healthy => {
      const lookup = vi.fn<(id: string) => Promise<BaseNode | null>>(async id => {
        if (id === '0:1') {
          if (healthy) return { id } as BaseNode;
          throw new Error('probe failed');
        }
        throw new Error('target failed');
      });
      const ctx = withInstanceIdLookup({
        currentPage: { id: '0:1' },
        getNodeByIdAsync: lookup,
      } as unknown as typeof figma);
      const errors = await Promise.all(
        ['8:8', '8:9'].map(id => ctx.getNodeByIdAsync(id).catch(error => error)),
      );
      for (const error of errors) {
        expect(error.message).toContain(
          healthy ? 'session answered other reads' : 'session is not answering reads',
        );
        expect(error.message).toContain(healthy ? 'reload is not indicated' : 'Reload the plugin');
        expect(error.cause.message).toBe('target failed');
        expect(error.message).toMatch(
          healthy
            ? /missing.*deleted.*page not loaded.*not yet synced/
            : /session is not answering reads/,
        );
        expect(error.message).toMatch(healthy ? /exporting.*parent/ : /Reload the plugin/);
        expect(error.message.includes('Reload the plugin')).toBe(!healthy);
      }
      expect(lookup.mock.calls.filter(([id]) => id === '0:1')).toHaveLength(1);
    },
  );

  it('does not probe a resolved null', async () => {
    const lookup = vi.fn<() => Promise<null>>(async () => null);
    const ctx = withInstanceIdLookup({ getNodeByIdAsync: lookup } as unknown as typeof figma);
    expect(await ctx.getNodeByIdAsync('8:8')).toBeNull();
    expect(lookup).toHaveBeenCalledExactlyOnceWith('8:8');
  });
  it.each([
    [BY_ID_TIMEOUT, 2, /failed twice/],
    [new TypeError('other failure'), 1, /failed: other failure.*session is not answering reads/],
    [new TypeError(BY_ID_TIMEOUT), 1, /failed: Unable to establish/],
    ['Unable to establish connection to Figma after 10 seconds', 1, /failed: Unable to establish/],
  ])('bounds attempts and preserves other rejections: %s', async (cause, attempts, message) => {
    vi.useFakeTimers();
    try {
      const lookup = vi.fn<(id: string) => Promise<BaseNode | null>>().mockRejectedValue(cause);
      const reading = withInstanceIdLookup({
        getNodeByIdAsync: lookup,
      } as unknown as typeof figma)
        .getNodeByIdAsync('8:8')
        .catch(error => error);
      await vi.runAllTimersAsync();
      const error = await reading;
      expect(error.message).toMatch(message as RegExp);
      expect(lookup).toHaveBeenCalledTimes(attempts as number);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['8:8', 'I8:8;8:9'])('names the failing plain or root lookup for %s', async id => {
    vi.useFakeTimers();
    try {
      const ctx = withInstanceIdLookup({
        getNodeByIdAsync: async () => Promise.reject(BY_ID_TIMEOUT),
      } as unknown as typeof figma);
      const failure = ctx.getNodeByIdAsync(id);
      const observed = failure.catch(error => error);
      await vi.runAllTimersAsync();
      await observed;
      await expect(failure).rejects.toBeInstanceOf(Error);
      await expect(failure).rejects.toMatchObject({ cause: { cause: BY_ID_TIMEOUT } });
      await expect(failure).rejects.toThrow('getNodeByIdAsync(8:8)');
      await expect(failure).rejects.toThrow(BY_ID_TIMEOUT);
      await expect(failure).rejects.toThrow(/session is not answering reads.*Reload the plugin/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a by-id lookup that rejects instance-qualified ids', () => {
  it.each([
    ['two-level', 'I2:6;2:5'],
    ['three-level (nested instance)', 'I2:6;3:1;3:2'],
    ['hidden sublayer', 'I2:6;2:7'],
  ])('falls back to the instance root for a %s sublayer', async (_, id) => {
    const { figmaCtx, lookups } = fakeFigma('rejects-instance-ids');
    const result = (await createSandboxHandlers(figmaCtx).get_node_motion!({
      nodeId: id,
    })) as GetNodeMotionResult;
    expect(result.nodeId).toBe(id);
    expect(result.motion?.animations).toEqual({ OPACITY: { keyframes: [{ time: 0, value: id }] } });
    expect(lookups).toEqual([id, '2:6']);
  });

  it('stops asking Figma by id once it has rejected, for the rest of the run', async () => {
    const { figmaCtx, lookups, sublayer, nestedChild } = fakeFigma('rejects-instance-ids');
    const ctx = withInstanceIdLookup(figmaCtx);
    expect(await ctx.getNodeByIdAsync('I2:6;2:5')).toBe(sublayer);
    expect(await ctx.getNodeByIdAsync('I2:6;3:1;3:2')).toBe(nestedChild);
    expect(await ctx.getNodeByIdAsync('I2:6;9:9')).toBeNull();
    expect(await ctx.getNodeByIdAsync('I7:7;2:5')).toBeNull();
    expect(lookups).toEqual(['I2:6;2:5', '2:6', '2:6', '2:6', '7:7']);
  });

  it('lets a write handler (rename_node) change the node it falls back to', async () => {
    const { figmaCtx, nestedChild, sublayer } = fakeFigma('rejects-instance-ids');
    const result = (await createSandboxHandlers(figmaCtx).rename_node!({
      nodeId: 'I2:6;3:1;3:2',
      name: 'renamed',
      requestId: 'r1',
    })) as MutateResult;
    expect(result).toEqual({ ok: true, nodeId: 'I2:6;3:1;3:2' });
    expect(nestedChild.name).toBe('renamed');
    expect(sublayer.name).toBe('I2:6;2:5');
  });
});

describe('withInstanceIdLookup forwards everything else to the real API object', () => {
  it('runs getters, setters and methods on the wrapped object', async () => {
    class Api {
      skip = false;
      calls: unknown[] = [];
      get skipInvisibleInstanceChildren(): boolean {
        return this.skip;
      }
      set skipInvisibleInstanceChildren(value: boolean) {
        this.skip = value;
      }
      notify(message: string): void {
        this.calls.push([this, message]);
      }
    }
    const api = new Api();
    const ctx = withInstanceIdLookup(api as unknown as typeof figma);
    ctx.skipInvisibleInstanceChildren = true;
    expect(api.skip).toBe(true);
    expect(ctx.skipInvisibleInstanceChildren).toBe(true);
    ctx.notify('hi');
    expect(api.calls).toEqual([[api, 'hi']]);
    expect('notify' in ctx).toBe(true);
  });
});
