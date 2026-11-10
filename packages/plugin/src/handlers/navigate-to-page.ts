import type { MutateResult } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import { figmaCall } from '../figma-call.js';
import { isPageLoadConnectionTimeout, loadPage } from '../page-lookup.js';

/** Switch the active page. Uses setCurrentPageAsync (required under dynamic-page document access). */
export const createNavigateToPageHandler =
  (figmaCtx: typeof figma): SandboxToolHandler =>
  async params => {
    const p = (params ?? {}) as { pageId?: unknown };
    if (typeof p.pageId !== 'string')
      throw new TypeError('navigate_to_page: pageId must be a string');

    let node: PageNode | null;
    let loadFailure: Error | undefined;
    try {
      node = await loadPage(figmaCtx, p.pageId);
    } catch (error) {
      if (!isPageLoadConnectionTimeout(error)) throw error;
      loadFailure = error;
      node = figmaCtx.root.children.find(page => page.id === p.pageId) ?? null;
    }
    if (node === null) {
      throw new Error(`navigate_to_page: page ${p.pageId} not found`);
    }
    try {
      await figmaCall('setCurrentPageAsync', node.id, () => figmaCtx.setCurrentPageAsync(node));
    } catch (error) {
      if (loadFailure === undefined) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line preserve-caught-error -- both attributed errors are retained in cause.
      throw new Error(`${loadFailure.message} Direct page switch also failed: ${message}`, {
        cause: { load: loadFailure, switch: error },
      });
    }

    const result: MutateResult & { note?: string } = { ok: true, nodeId: node.id };
    if (loadFailure !== undefined)
      result.note = 'The page load timed out; the page was switched directly.';
    return result;
  };
