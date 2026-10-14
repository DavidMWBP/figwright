import type { GetNodeMotionResult, MutateResult } from '@figwright/shared';
import { describe, expect, it } from 'vitest';

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
  it.each(['8:8', 'I8:8;8:9'])('names the failing plain or root lookup for %s', async id => {
    const ctx = withInstanceIdLookup({
      getNodeByIdAsync: async () => Promise.reject(BY_ID_TIMEOUT),
    } as unknown as typeof figma);
    const failure = ctx.getNodeByIdAsync(id);
    await expect(failure).rejects.toBeInstanceOf(Error);
    await expect(failure).rejects.toMatchObject({ cause: BY_ID_TIMEOUT });
    await expect(failure).rejects.toThrow('getNodeByIdAsync(8:8)');
    await expect(failure).rejects.toThrow(BY_ID_TIMEOUT);
    await expect(failure).rejects.toThrow(/id may not exist.*other reads may still work/);
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
