import type { MutateResult } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import { loadPage } from '../page-lookup.js';

/** Rename a page by id. */
export const createRenamePageHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const p = (params ?? {}) as { pageId?: unknown; name?: unknown };
    if (typeof p.pageId !== 'string') throw new TypeError('rename_page: pageId must be a string');
    if (typeof p.name !== 'string') throw new TypeError('rename_page: name must be a string');

    const node = await loadPage(figmaCtx, p.pageId);
    if (node === null) {
      throw new Error(`rename_page: page ${p.pageId} not found`);
    }
    node.name = p.name;

    const result: MutateResult = { ok: true, nodeId: node.id };
    return result;
  };
