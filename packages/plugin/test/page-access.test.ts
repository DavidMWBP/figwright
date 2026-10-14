import { describe, expect, it } from 'vitest';

import { createBatchHandler } from '../src/handlers/batch.js';
import { createDeletePageHandler } from '../src/handlers/delete-page.js';
import { createNavigateToPageHandler } from '../src/handlers/navigate-to-page.js';
import { createRenamePageHandler } from '../src/handlers/rename-page.js';
import { createUpdateFlowsHandler } from '../src/handlers/update-flows.js';
import { resolveScope } from '../src/traverse.js';
import { unloadedPage } from './page-fake.js';

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
