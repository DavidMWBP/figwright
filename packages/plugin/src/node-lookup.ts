/** `I<outermost instance id>;…` — the first segment is a plain id Figma can look up. */
const INSTANCE_QUALIFIED = /^I([^;]+);/;

/** Attribute Figma's connection-like rejection to the lookup that actually failed. */
const lookup = async (figmaCtx: typeof figma, id: string): Promise<BaseNode | null> => {
  try {
    return await figmaCtx.getNodeByIdAsync(id);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `getNodeByIdAsync(${id}) failed: ${message} The id may not exist; other reads may still work.`,
      { cause },
    );
  }
};

/** Find an instance-qualified id under its outermost instance, as Figma's lookup would. */
const walkFromInstanceRoot = async (
  figmaCtx: typeof figma,
  root: string,
  id: string,
): Promise<BaseNode | null> => {
  const instance = await lookup(figmaCtx, root);
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
 * unchanged; plain-id and root lookup rejections become Errors with the id and original cause.
 *
 * Wrapping here, where the handler map is built, covers every handler and helper without touching
 * their call sites. The proxy forwards to `figmaCtx` over an empty target, so getters and setters
 * (`skipInvisibleInstanceChildren`) run on the real API object.
 */
export const withInstanceIdLookup = (figmaCtx: typeof figma): typeof figma => {
  let byIdRejected = false;
  const getNodeByIdAsync = async (id: string): Promise<BaseNode | null> => {
    const root = INSTANCE_QUALIFIED.exec(id)?.[1];
    if (root === undefined) return lookup(figmaCtx, id);
    if (byIdRejected) return walkFromInstanceRoot(figmaCtx, root, id);
    try {
      return await figmaCtx.getNodeByIdAsync(id);
    } catch {
      byIdRejected = true;
      return walkFromInstanceRoot(figmaCtx, root, id);
    }
  };
  return new Proxy({} as typeof figma, {
    get: (_, prop) => {
      if (prop === 'getNodeByIdAsync') return getNodeByIdAsync;
      const value: unknown = Reflect.get(figmaCtx, prop);
      return typeof value === 'function' ? value.bind(figmaCtx) : value;
    },
    set: (_, prop, value) => Reflect.set(figmaCtx, prop, value),
    has: (_, prop) => Reflect.has(figmaCtx, prop),
  });
};
