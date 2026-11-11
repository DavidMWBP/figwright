import type { SandboxToolHandler } from './dispatcher.js';
import type { WriteSignal } from './write-signal.js';

export const DEFAULT_IDEMPOTENCY_TTL_MS = 60_000;

interface Entry {
  result: Promise<unknown>;
  ts: number | undefined;
}

export interface IdempotencyCache {
  /**
   * Share in-flight calls by requestId and replay successful results within the TTL. A call the
   * write queue abandons (`signal`) is replayed as its abandonment error for the TTL instead, so a
   * retry never waits on a write that may never settle.
   */
  run(
    requestId: string | undefined,
    fn: () => unknown | Promise<unknown>,
    signal?: WriteSignal,
  ): Promise<unknown>;
  size(): number;
}

/**
 * Dedupe write side-effects across retries. The server reuses one requestId for all retries of a
 * logical tool call (our resilience layer retries on transport errors), so a replayed write must
 * not apply twice — it returns the original result instead.
 */
export const createIdempotencyCache = (
  ttlMs: number = DEFAULT_IDEMPOTENCY_TTL_MS,
  now: () => number = Date.now,
): IdempotencyCache => {
  const map = new Map<string, Entry>();

  const prune = (): void => {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of map) {
      if (entry.ts !== undefined && entry.ts < cutoff) map.delete(key);
    }
  };

  return {
    async run(requestId, fn, signal) {
      if (requestId === undefined) return fn(); // no key → no dedup
      const hit = map.get(requestId);
      if (hit !== undefined && (hit.ts === undefined || now() - hit.ts < ttlMs)) return hit.result;
      // Defer fn until its in-flight entry is reserved.
      const entry: Entry = { result: Promise.resolve().then(fn), ts: undefined };
      map.set(requestId, entry);
      signal?.onAbandon(reason => {
        const replay = Promise.reject(reason);
        replay.catch(() => {}); // replayed only to retries; never unhandled
        map.set(requestId, { result: replay, ts: now() });
      });
      try {
        const result = await entry.result;
        if (map.get(requestId) !== entry) return result; // abandoned: keep its error entry
        entry.ts = now();
        prune();
        return result;
      } catch (error) {
        if (map.get(requestId) === entry) map.delete(requestId);
        throw error;
      }
    },
    size: () => [...map.values()].filter(entry => entry.ts !== undefined).length,
  };
};

/**
 * Wrap a write handler so repeated calls carrying the same `requestId` apply the effect once. Calls
 * without a requestId run normally (reads, or writes invoked without idempotency).
 */
export const idempotent =
  (cache: IdempotencyCache, handler: SandboxToolHandler): SandboxToolHandler =>
  (params, context) => {
    const requestId = (params as { requestId?: unknown } | null)?.requestId;
    return cache.run(
      typeof requestId === 'string' ? requestId : undefined,
      () => handler(params, context),
      context?.signal,
    );
  };
