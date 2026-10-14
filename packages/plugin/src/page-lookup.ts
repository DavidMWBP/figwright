/** Resolve page metadata without a node lookup, then load its contents before access. */
export const loadPage = async (figmaCtx: typeof figma, id: string): Promise<PageNode | null> => {
  const page = figmaCtx.root.children.find(candidate => candidate.id === id);
  if (page === undefined) return null;
  try {
    await page.loadAsync();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PageNode.loadAsync(${id}) failed: ${message}`, { cause: error });
  }
  return page;
};
