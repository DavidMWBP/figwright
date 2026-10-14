import type { MutateResult } from '@figwright/shared';
import { describe, expect, it } from 'vitest';

import { createRenamePageHandler } from '../../src/handlers/rename-page.js';
import { unloadedPage } from '../page-fake.js';

it('loads a page from root.children before accessing it', async () => {
  const f = unloadedPage();
  const running = Promise.resolve(
    createRenamePageHandler(f.figmaCtx)({ pageId: f.page.id, name: 'After' }),
  );
  void running.catch(() => {});
  expect(f.loadAsync).toHaveBeenCalledOnce();
  expect(f.getNodeByIdAsync).not.toHaveBeenCalled();
  f.finish();
  await running;
  expect(f.page.name).toBe('After');
  expect(f.getNodeByIdAsync).not.toHaveBeenCalled();
});

const fakeFigma = (page: unknown): typeof figma =>
  ({
    root: { children: page ? [page] : [] },
    getNodeByIdAsync: async () => page,
  }) as unknown as typeof figma;

describe('rename_page handler', () => {
  it('renames a page', async () => {
    const page = { id: 'P:1', type: 'PAGE', name: 'old', loadAsync: async () => {} };
    const result = (await createRenamePageHandler(fakeFigma(page))({
      pageId: 'P:1',
      name: 'Components',
    })) as MutateResult;
    expect(page.name).toBe('Components');
    expect(result).toEqual({ ok: true, nodeId: 'P:1' });
  });

  it('throws on missing page or bad input', async () => {
    await expect(
      createRenamePageHandler(fakeFigma(null))({ pageId: 'P:9', name: 'x' }),
    ).rejects.toThrow(/not found/);
    await expect(createRenamePageHandler(fakeFigma(null))({ pageId: 'P:1' })).rejects.toThrow(
      /name/,
    );
    await expect(createRenamePageHandler(fakeFigma(null))({ name: 'x' })).rejects.toThrow(/pageId/);
  });
});
