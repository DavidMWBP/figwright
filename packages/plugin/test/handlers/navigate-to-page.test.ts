import type { MutateResult } from '@figwright/shared';
import { describe, expect, it, vi } from 'vitest';

import { createNavigateToPageHandler } from '../../src/handlers/navigate-to-page.js';
import { createSandboxHandlers } from '../../src/handlers/registry.js';
import { unloadedPage } from '../page-fake.js';

it('loads a page from root.children before accessing it', async () => {
  const f = unloadedPage();
  const running = Promise.resolve(createNavigateToPageHandler(f.figmaCtx)({ pageId: f.page.id }));
  void running.catch(() => {});
  expect(f.loadAsync).toHaveBeenCalledOnce();
  expect(f.getNodeByIdAsync).not.toHaveBeenCalled();
  f.finish();
  await running;
  expect(f.figmaCtx.currentPage.id).toBe(f.page.id);
  expect(f.getNodeByIdAsync).not.toHaveBeenCalled();
});

describe('navigate_to_page handler', () => {
  it.each(['load', 'switch'])('attributes page %s rejection', async boundary => {
    const cause = new Error('unavailable');
    const reject = async () => {
      throw cause;
    };
    const handlers = createSandboxHandlers({
      root: {
        children: [
          { id: 'P:2', type: 'PAGE', loadAsync: boundary === 'load' ? reject : async () => {} },
        ],
      },
      setCurrentPageAsync: reject,
    } as unknown as typeof figma);
    const error = await Promise.resolve(handlers.navigate_to_page!({ pageId: 'P:2' })).catch(
      e => e,
    );
    expect(error).toMatchObject({
      message: `${boundary === 'load' ? 'PageNode.loadAsync' : 'setCurrentPageAsync'}(P:2) failed: unavailable`,
      cause,
    });
  });
  it('switches the active page via setCurrentPageAsync', async () => {
    const page = { id: 'P:2', type: 'PAGE', loadAsync: async () => {} };
    const setCurrentPageAsync = vi.fn<() => Promise<void>>(async () => {});
    const f = {
      root: { children: [page] },
      getNodeByIdAsync: async () => page,
      setCurrentPageAsync,
    } as unknown as typeof figma;

    const result = (await createNavigateToPageHandler(f)({ pageId: 'P:2' })) as MutateResult;
    expect(setCurrentPageAsync).toHaveBeenCalledWith(page);
    expect(result).toEqual({ ok: true, nodeId: 'P:2' });
  });

  it('throws on missing page or bad input', async () => {
    const f = {
      root: { children: [] },
      getNodeByIdAsync: async () => null,
      setCurrentPageAsync: vi.fn<() => Promise<void>>(async () => {}),
    } as unknown as typeof figma;
    await expect(createNavigateToPageHandler(f)({ pageId: 'P:9' })).rejects.toThrow(/not found/);
    await expect(createNavigateToPageHandler(f)({})).rejects.toThrow(/pageId/);
  });
});
