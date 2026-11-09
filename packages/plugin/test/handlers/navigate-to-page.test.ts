import type { MutateResult } from '@figwright/shared';
import { describe, expect, it, vi } from 'vitest';

import { createNavigateToPageHandler } from '../../src/handlers/navigate-to-page.js';
import { createSandboxHandlers } from '../../src/handlers/registry.js';
import { unloadedPage } from '../page-fake.js';
import { CONNECTION_ERROR } from '../read-retry-fake.js';

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
  it('switches directly after the page load connection timeout is exhausted', async () => {
    vi.useFakeTimers();
    try {
      const f = unloadedPage();
      f.loadAsync.mockRejectedValue(new Error(CONNECTION_ERROR));
      const switchPage = vi
        .mocked(f.figmaCtx.setCurrentPageAsync)
        .mockImplementation(async page => {
          f.figmaCtx.currentPage = page;
        });
      const running = Promise.resolve(
        createSandboxHandlers(f.figmaCtx).navigate_to_page!({ pageId: f.page.id }),
      ).catch(error => error);
      await vi.runAllTimersAsync();
      expect(await running).toMatchObject({
        ok: true,
        nodeId: 'P:2',
        note: expect.stringMatching(/load timed out.*switched directly/i),
      });
      expect(switchPage).toHaveBeenCalledExactlyOnceWith(f.page);
      expect(f.figmaCtx.currentPage).toBe(f.page);
      expect(f.loadAsync).toHaveBeenCalledTimes(2);
      expect(f.getNodeByIdAsync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves both attributed causes when the direct switch also rejects', async () => {
    vi.useFakeTimers();
    try {
      const f = unloadedPage();
      const loadCause = new Error(CONNECTION_ERROR);
      const switchCause = new Error('switch unavailable');
      f.loadAsync.mockRejectedValue(loadCause);
      vi.mocked(f.figmaCtx.setCurrentPageAsync).mockRejectedValue(switchCause);
      const running = Promise.resolve(
        createSandboxHandlers(f.figmaCtx).navigate_to_page!({ pageId: f.page.id }),
      ).catch(error => error);
      await vi.runAllTimersAsync();
      const error = (await running) as Error;
      expect(error.message).toContain(`PageNode.loadAsync(P:2) failed: ${CONNECTION_ERROR}`);
      expect(error.message).toContain('setCurrentPageAsync(P:2) failed: switch unavailable');
      expect(error.cause).toMatchObject({
        load: { cause: { cause: loadCause } },
        switch: { cause: switchCause },
      });
      expect(f.loadAsync).toHaveBeenCalledTimes(2);
      expect(f.figmaCtx.setCurrentPageAsync).toHaveBeenCalledExactlyOnceWith(f.page);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    new Error('contents unavailable'),
    new TypeError(CONNECTION_ERROR),
    'Unable to establish connection to Figma after 10 seconds',
  ])('does not switch for a non-retryable load error: %s', async cause => {
    const f = unloadedPage();
    f.loadAsync.mockRejectedValue(cause);
    const error = (await Promise.resolve(
      createSandboxHandlers(f.figmaCtx).navigate_to_page!({ pageId: f.page.id }),
    ).catch(failure => failure)) as Error;
    expect(error).toMatchObject({ cause });
    expect(error.message).toMatch(/^PageNode.loadAsync\(P:2\) failed:/);
    expect(f.loadAsync).toHaveBeenCalledOnce();
    expect(f.figmaCtx.setCurrentPageAsync).not.toHaveBeenCalled();
  });

  it.each([new Error('page removed'), new TypeError(CONNECTION_ERROR)])(
    'does not switch when the retry fails with a non-retryable error: %s',
    async cause => {
      vi.useFakeTimers();
      try {
        const f = unloadedPage();
        f.loadAsync.mockRejectedValueOnce(CONNECTION_ERROR).mockRejectedValueOnce(cause);
        const running = Promise.resolve(
          createSandboxHandlers(f.figmaCtx).navigate_to_page!({ pageId: f.page.id }),
        ).catch(error => error);
        await vi.runAllTimersAsync();
        expect(await running).toMatchObject({ cause: { cause } });
        expect(f.loadAsync).toHaveBeenCalledTimes(2);
        expect(f.figmaCtx.setCurrentPageAsync).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

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
    expect(f.setCurrentPageAsync).not.toHaveBeenCalled();
  });
});
