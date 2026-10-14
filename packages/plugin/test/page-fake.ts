import { expect, vi } from 'vitest';

/** A page whose contents become readable only when its explicit load completes. */
export const unloadedPage = () => {
  let loaded = false;
  let finish!: () => void;
  const loading = new Promise<void>(resolve => {
    finish = resolve;
  });
  const loadAsync = vi.fn<() => Promise<void>>(async () => {
    await loading;
    loaded = true;
  });
  const children = [{ id: 'child', type: 'FRAME', parent: null }] as unknown as SceneNode[];
  const page = {
    id: 'P:2',
    type: 'PAGE',
    name: 'Before',
    loadAsync,
    remove: vi.fn<() => void>(() => {
      expect(loaded).toBe(true);
    }),
    get children() {
      expect(loaded).toBe(true);
      return children;
    },
    get flowStartingPoints() {
      expect(loaded).toBe(true);
      return [];
    },
  } as unknown as PageNode;
  const currentPage = {
    id: 'P:1',
    type: 'PAGE',
    flowStartingPoints: [],
    loadAsync: vi.fn<() => Promise<void>>(async () => {}),
  };
  const getNodeByIdAsync = vi.fn<(id: string) => Promise<BaseNode | null>>(async () => null);
  const setCurrentPageAsync = vi.fn<(target: PageNode) => Promise<void>>(async target => {
    expect(loaded).toBe(true);
    figmaCtx.currentPage = target;
  });
  const figmaCtx = {
    root: { children: [currentPage, page] },
    currentPage,
    getNodeByIdAsync,
    setCurrentPageAsync,
  } as unknown as typeof figma;
  return { figmaCtx, page, children, loadAsync, getNodeByIdAsync, finish };
};
