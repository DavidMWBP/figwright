import { figmaCall } from './figma-call.js';
import { retryRead } from './read-retry.js';

/** Resolve page metadata without a node lookup, then load its contents before access. */
export const loadPage = async (figmaCtx: typeof figma, id: string): Promise<PageNode | null> => {
  const page = figmaCtx.root.children.find(candidate => candidate.id === id);
  if (page === undefined) return null;
  await figmaCall('PageNode.loadAsync', id, () => retryRead(figmaCtx, () => page.loadAsync()));
  return page;
};
