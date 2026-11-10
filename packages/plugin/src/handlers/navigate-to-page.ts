import type { MutateResult } from '@figwright/shared';

import type { SandboxToolHandler } from '../dispatcher.js';
import { figmaCall } from '../figma-call.js';
import { isPageLoadConnectionTimeout, isPageLoadDeadline, loadPage } from '../page-lookup.js';

/**
 * Bound on one setCurrentPageAsync call. With PAGE_LOAD_DEADLINE_MS it stays under the
 * navigate_to_page tool budget, so the handler answers before the UI bridge gives up.
 */
export const PAGE_SWITCH_DEADLINE_MS = 30_000;

const SWITCH_GUIDANCE =
  'The page switch may still complete in Figma, so read the current page back (get_selection returns its pageId) before retrying. ' +
  'To read the page without switching, pass a node id on that page as root to search_nodes, scan_nodes_by_types or scan_text_nodes, or use get_node.';

const expiredSwitches = new WeakSet<Error>();

// The race keeps a handler on the switch, so a late settle is neither unhandled nor a second result.
const switchPage = async (figmaCtx: typeof figma, page: PageNode): Promise<void> => {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error(`page switch exceeded ${PAGE_SWITCH_DEADLINE_MS / 1000} s`));
    }, PAGE_SWITCH_DEADLINE_MS);
  });
  try {
    await figmaCall('setCurrentPageAsync', page.id, () =>
      Promise.race([figmaCtx.setCurrentPageAsync(page), deadline]),
    );
  } catch (error) {
    if (expired && error instanceof Error) expiredSwitches.add(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

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
      if (!isPageLoadConnectionTimeout(error) && !isPageLoadDeadline(error)) throw error;
      loadFailure = error;
      node = figmaCtx.root.children.find(page => page.id === p.pageId) ?? null;
    }
    if (node === null) {
      throw new Error(`navigate_to_page: page ${p.pageId} not found`);
    }
    try {
      await switchPage(figmaCtx, node);
    } catch (error) {
      const expired = error instanceof Error && expiredSwitches.has(error);
      if (loadFailure === undefined && !expired) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (loadFailure === undefined)
        throw new Error(`${message} ${SWITCH_GUIDANCE}`, { cause: error });
      // eslint-disable-next-line preserve-caught-error -- both attributed errors are retained in cause.
      throw new Error(
        `${loadFailure.message} Direct page switch also failed: ${message} ${SWITCH_GUIDANCE}`,
        { cause: { load: loadFailure, switch: error } },
      );
    }

    const result: MutateResult & { note?: string } = { ok: true, nodeId: node.id };
    if (loadFailure !== undefined)
      result.note = 'The page load timed out; the page was switched directly.';
    return result;
  };
