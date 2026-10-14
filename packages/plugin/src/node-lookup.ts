import { attachReadRetry, retryRead, type ReadRetryState } from './read-retry.js';

/** `I<outermost instance id>;…` — the first segment is a plain id Figma can look up. */
const INSTANCE_QUALIFIED = /^I([^;]+);/;

/** Attribute Figma's connection-like rejection to the lookup that actually failed. */
const lookup = async (
  figmaCtx: typeof figma,
  id: string,
  retryCtx: typeof figma,
  probe: () => Promise<boolean>,
): Promise<BaseNode | null> => {
  try {
    return await retryRead(retryCtx, () => figmaCtx.getNodeByIdAsync(id));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const advice = (await probe())
      ? 'The target lookup failed while the session answered other reads. The id may be missing, deleted, on a page not loaded, or not yet synced from another client. A plugin reload is not indicated; try exporting the node or reading its parent.'
      : 'The session is not answering reads: the loaded-page health probe failed too. Reload the plugin to restore reads.';
    throw new Error(`getNodeByIdAsync(${id}) failed: ${message} ${advice}`, { cause });
  }
};

/** Find an instance-qualified id under its outermost instance, as Figma's lookup would. */
const walkFromInstanceRoot = async (
  figmaCtx: typeof figma,
  root: string,
  id: string,
  retryCtx: typeof figma,
  probe: () => Promise<boolean>,
): Promise<BaseNode | null> => {
  const instance = await lookup(figmaCtx, root, retryCtx, probe);
  if (instance === null || !('findOne' in instance)) return null;
  // With skipInvisibleInstanceChildren on, a hidden sublayer is skipped here just as Figma's own
  // lookup returns null for it.
  return instance.findOne(node => node.id === id);
};

/**
 * The Figma API every handler receives: identical to `figmaCtx` except that `getNodeByIdAsync`
 * survives Figma's by-id lookup failing on an instance-qualified id (`I2:6;2:5`).
 *
 * Figma's own lookup goes first: walking costs time in proportion to the instance's size (measured
 * as whole get_node calls: ~25 ms through Figma's lookup, ~180 ms walking a 4,400-layer instance).
 * Figma's lookup has been seen to reject such an id after waiting 10 s while the instance root
 * still resolved; only then is the id resolved by walking from the root, and the rest of this
 * plugin run walks directly instead of waiting on Figma again. Resolved nodes and null pass through
 * unchanged; plain-id and root lookup rejections become Errors with the id and original cause. Only
 * the exact platform connection error retries a plain/root read once after 250 ms, with three
 * retries shared by lookups, page loads and screenshot exports per tool call. Null and other errors
 * do not retry. An instance-qualified rejection still walks immediately; the synchronous walk is
 * never retried. Batch capture permits retries before its time reserve; apply and rollback disable
 * them. No write or handler is repeated.
 *
 * Wrapping here, where the handler map is built, covers every handler and helper without touching
 * their call sites. The proxy forwards to `figmaCtx` over an empty target, so getters and setters
 * (`skipInvisibleInstanceChildren`) run on the real API object.
 */
export const withInstanceIdLookup = (
  figmaCtx: typeof figma,
  retryState: ReadRetryState = { used: 0, enabled: true },
  fallback = { byIdRejected: false },
): typeof figma => {
  // The registry creates this proxy per tool invocation. Cache the promise before awaiting it so
  // concurrent failed ids share one raw read, without spending or repeating the retry allowance.
  let health: Promise<boolean> | undefined;
  const probe = (): Promise<boolean> => {
    health ??= (async () => {
      try {
        const page = figmaCtx.currentPage;
        return (await figmaCtx.getNodeByIdAsync(page.id)) !== null;
      } catch {
        return false;
      }
    })();
    return health;
  };
  const getNodeByIdAsync = async (id: string): Promise<BaseNode | null> => {
    const root = INSTANCE_QUALIFIED.exec(id)?.[1];
    if (root === undefined) return lookup(figmaCtx, id, proxy, probe);
    if (fallback.byIdRejected) return walkFromInstanceRoot(figmaCtx, root, id, proxy, probe);
    try {
      return await figmaCtx.getNodeByIdAsync(id);
    } catch {
      fallback.byIdRejected = true;
      return walkFromInstanceRoot(figmaCtx, root, id, proxy, probe);
    }
  };
  const proxy = new Proxy({} as typeof figma, {
    get: (_, prop) => {
      if (prop === 'getNodeByIdAsync') return getNodeByIdAsync;
      const value: unknown = Reflect.get(figmaCtx, prop);
      return typeof value === 'function' ? value.bind(figmaCtx) : value;
    },
    set: (_, prop, value) => Reflect.set(figmaCtx, prop, value),
    has: (_, prop) => Reflect.has(figmaCtx, prop),
  });
  attachReadRetry(proxy, retryState);
  return proxy;
};
