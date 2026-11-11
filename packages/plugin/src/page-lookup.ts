import { figmaCall } from './figma-call.js';
import { retryRead } from './read-retry.js';
import { throwIfAbandoned } from './write-signal.js';

const CONNECTION_ERROR =
  'Unable to establish connection to Figma after 10 seconds. Please check your internet connection.';
const timedOutLoads = new WeakSet<Error>();
const expiredLoads = new WeakSet<Error>();

/**
 * Overall bound on one page load, retry included. It outlasts the 20.25 s retry path (two 10 s
 * connection timeouts and a 250 ms pause) and fires before the 30 s default sandbox budget, so
 * callers get a named error instead of a bare bridge timeout. If Figma blocks the sandbox thread
 * during the load, this timer cannot fire; the UI bridge's timeout covers that case.
 */
export const PAGE_LOAD_DEADLINE_MS = 25_000;

/** Classify the last API rejection, without mistaking retry/boundary prose for an API error. */
export const isPageLoadConnectionTimeout = (error: unknown): error is Error =>
  error instanceof Error && timedOutLoads.has(error);

/** Classify a page load that did not settle within `PAGE_LOAD_DEADLINE_MS`. */
export const isPageLoadDeadline = (error: unknown): error is Error =>
  error instanceof Error && expiredLoads.has(error);

/** Resolve page metadata without a node lookup, then load its contents before access. */
export const loadPage = async (figmaCtx: typeof figma, id: string): Promise<PageNode | null> => {
  const page = figmaCtx.root.children.find(candidate => candidate.id === id);
  if (page === undefined) return null;
  let timedOut = false;
  let expired = false;
  const read = async (): Promise<void> => {
    try {
      await page.loadAsync();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      timedOut = !(cause instanceof TypeError) && message === CONNECTION_ERROR;
      throw cause;
    }
  };
  // The race keeps a handler on the load, so a late settle is neither unhandled nor a second result.
  const bounded = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error(`page load exceeded ${PAGE_LOAD_DEADLINE_MS / 1000} s`));
      }, PAGE_LOAD_DEADLINE_MS);
    });
    try {
      await Promise.race([retryRead(figmaCtx, read), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await figmaCall('PageNode.loadAsync', id, bounded);
  } catch (error) {
    if (error instanceof Error) {
      if (expired) expiredLoads.add(error);
      else if (timedOut) timedOutLoads.add(error);
    }
    throw error;
  }
  // `page.loadAsync` is the page's own method, so an abandoned write is stopped here, explicitly.
  throwIfAbandoned(figmaCtx);
  return page;
};
