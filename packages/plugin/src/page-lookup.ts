import { figmaCall } from './figma-call.js';
import { retryRead } from './read-retry.js';

const CONNECTION_ERROR =
  'Unable to establish connection to Figma after 10 seconds. Please check your internet connection.';
const timedOutLoads = new WeakSet<Error>();

/** Classify the last API rejection, without mistaking retry/boundary prose for an API error. */
export const isPageLoadConnectionTimeout = (error: unknown): error is Error =>
  error instanceof Error && timedOutLoads.has(error);

/** Resolve page metadata without a node lookup, then load its contents before access. */
export const loadPage = async (figmaCtx: typeof figma, id: string): Promise<PageNode | null> => {
  const page = figmaCtx.root.children.find(candidate => candidate.id === id);
  if (page === undefined) return null;
  let timedOut = false;
  const read = async (): Promise<void> => {
    try {
      await page.loadAsync();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      timedOut = !(cause instanceof TypeError) && message === CONNECTION_ERROR;
      throw cause;
    }
  };
  try {
    await figmaCall('PageNode.loadAsync', id, () => retryRead(figmaCtx, read));
  } catch (error) {
    if (timedOut && error instanceof Error) timedOutLoads.add(error);
    throw error;
  }
  return page;
};
