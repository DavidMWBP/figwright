import { describe, expect, it, vi } from 'vitest';

import { createBatchHandler } from '../src/handlers/batch.js';
import { createDeletePageHandler } from '../src/handlers/delete-page.js';
import { createNavigateToPageHandler } from '../src/handlers/navigate-to-page.js';
import { createRenamePageHandler } from '../src/handlers/rename-page.js';
import { createUpdateFlowsHandler } from '../src/handlers/update-flows.js';
import { withInstanceIdLookup } from '../src/node-lookup.js';
import { resolveScope } from '../src/traverse.js';
import { unloadedPage } from './page-fake.js';
import { CONNECTION_ERROR } from './read-retry-fake.js';

const handlers = [
  ['navigate_to_page', createNavigateToPageHandler],
  ['rename_page', createRenamePageHandler],
  ['delete_page', createDeletePageHandler],
  ['update_flows', createUpdateFlowsHandler],
] as const;

it.each(['navigate_to_page', 'update_flows'])(
  'preserves page capture errors for %s',
  async tool => {
    const f = unloadedPage();
    const handler = createBatchHandler(f.figmaCtx, {
      navigate_to_page: createNavigateToPageHandler(f.figmaCtx),
      update_flows: createUpdateFlowsHandler(f.figmaCtx),
    });
    const run = (pageId: string) => handler({ ops: [{ tool, params: { pageId } }] });
    await expect(run('missing')).rejects.toThrow(`batch/${tool}: node missing not found`);
    f.getNodeByIdAsync.mockResolvedValue({ id: 'frame', type: 'FRAME' } as BaseNode);
    await expect(run('frame')).rejects.toThrow(
      tool === 'update_flows'
        ? 'batch/update_flows: frame is not a page'
        : 'batch/navigate_to_page: page frame not found',
    );
    f.getNodeByIdAsync.mockClear();
    f.loadAsync.mockRejectedValue(new Error('contents unavailable'));
    await expect(run(f.page.id)).rejects.toThrow(
      'PageNode.loadAsync(P:2) failed: contents unavailable',
    );
    expect(f.getNodeByIdAsync).not.toHaveBeenCalled();
    expect(f.figmaCtx.setCurrentPageAsync).not.toHaveBeenCalled();
  },
);

describe.each(handlers)('%s page access', (tool, create) => {
  it.each(['missing', 'frame'])('preserves the error for %s ids', async id => {
    const f = unloadedPage();
    f.getNodeByIdAsync.mockImplementation(async () =>
      id === 'frame' ? ({ id, type: 'FRAME' } as BaseNode) : null,
    );
    const message =
      tool === 'update_flows' && id === 'frame'
        ? 'update_flows: frame is a FRAME, not a page — get_pages lists page ids'
        : `${tool}: page ${id} not found`;
    await expect(create(f.figmaCtx)({ pageId: id, name: 'After' })).rejects.toThrow(message);
    expect(f.loadAsync).not.toHaveBeenCalled();
  });

  it('attributes a rejected page load before any mutation', async () => {
    const f = unloadedPage();
    f.loadAsync.mockRejectedValue(new Error('contents unavailable'));
    await expect(create(f.figmaCtx)({ pageId: f.page.id, name: 'After' })).rejects.toThrow(
      'PageNode.loadAsync(P:2) failed: contents unavailable',
    );
    expect(f.page.name).toBe('Before');
    expect(f.page.remove).not.toHaveBeenCalled();
    expect(f.figmaCtx.setCurrentPageAsync).not.toHaveBeenCalled();
  });
});

it('loads the current page when explicitly used as a scope without switching it', async () => {
  const f = unloadedPage();
  f.figmaCtx.currentPage = f.page;
  f.finish();
  expect(await resolveScope(f.figmaCtx, f.page.id)).toBe(f.children);
  expect(f.loadAsync).toHaveBeenCalledOnce();
  expect(f.figmaCtx.setCurrentPageAsync).not.toHaveBeenCalled();
});

it.each([true, false])(
  'diagnoses a non-current page timeout with one probe (healthy=%s)',
  async healthy => {
    vi.useFakeTimers();
    try {
      const f = unloadedPage();
      const cause = new Error(CONNECTION_ERROR);
      f.loadAsync.mockRejectedValue(cause);
      if (!healthy) f.getNodeByIdAsync.mockRejectedValue(new Error(CONNECTION_ERROR));
      const ctx = withInstanceIdLookup(f.figmaCtx);
      const running = Promise.all([
        resolveScope(ctx, f.page.id).catch(error => error),
        resolveScope(ctx, f.page.id).catch(error => error),
      ]);
      await vi.runAllTimersAsync();
      for (const error of await running) {
        expect(error.message).toContain(`PageNode.loadAsync(P:2) failed: ${CONNECTION_ERROR}`);
        expect(error.message).toContain('Read failed twice.');
        expect(error.message).toContain('page "Before" (P:2)');
        expect(error.cause).toMatchObject({ cause });
        expect(error.message).toMatch(
          healthy
            ? /current page still answers.*Open.*page.*Figma.*retry/
            : /session is not answering reads.*Reload the plugin/,
        );
        expect(error.message.includes('Reload the plugin')).toBe(!healthy);
      }
      expect(f.getNodeByIdAsync).toHaveBeenCalledExactlyOnceWith('P:1');
      expect(f.figmaCtx.setCurrentPageAsync).not.toHaveBeenCalled();
      expect(f.figmaCtx.currentPage.id).toBe('P:1');
    } finally {
      vi.useRealTimers();
    }
  },
);

it('shares the three-retry allowance between page loads and node lookups', async () => {
  vi.useFakeTimers();
  try {
    const f = unloadedPage();
    f.loadAsync.mockRejectedValue(CONNECTION_ERROR);
    f.getNodeByIdAsync.mockImplementation(async id => {
      if (id === 'P:1') return null;
      throw new Error(CONNECTION_ERROR);
    });
    const ctx = withInstanceIdLookup(f.figmaCtx);
    const running = (async () => {
      await ctx.getNodeByIdAsync('8:1').catch(error => error);
      await resolveScope(ctx, f.page.id).catch(error => error);
      await ctx.getNodeByIdAsync('8:2').catch(error => error);
      return resolveScope(ctx, f.page.id).catch(error => error);
    })();
    await vi.runAllTimersAsync();
    const error = await running;
    expect(error.message).toContain('Retry cap reached (3 per tool call).');
    expect(error.message).toContain('current page still answers');
    expect(f.loadAsync).toHaveBeenCalledTimes(3);
    expect(f.getNodeByIdAsync.mock.calls).toEqual([['8:1'], ['8:1'], ['P:1'], ['8:2'], ['8:2']]);
    expect(f.figmaCtx.setCurrentPageAsync).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it.each([new Error('unavailable'), 'unavailable'])(
  'attributes scope load rejection %s',
  async failure => {
    const f = unloadedPage();
    f.loadAsync.mockRejectedValue(failure);
    await expect(resolveScope(f.figmaCtx, f.page.id)).rejects.toThrow(
      'PageNode.loadAsync(P:2) failed: unavailable',
    );
    expect(f.getNodeByIdAsync).not.toHaveBeenCalled();
  },
);
