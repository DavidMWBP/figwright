import { describe, expect, it, vi } from 'vitest';

import { createIdempotencyCache, idempotent } from '../src/idempotency.js';
import { WriteAbandonedError, WriteSignal } from '../src/write-signal.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('createIdempotencyCache', () => {
  it('runs the handler once for overlapping calls with the same key', async () => {
    const cache = createIdempotencyCache();
    const pending = deferred<{ ok: boolean }>();
    const fn = vi.fn<() => Promise<{ ok: boolean }>>(() => pending.promise);
    const first = cache.run('same', fn);
    const second = cache.run('same', fn);
    expect(cache.size()).toBe(0);

    const result = { ok: true };
    pending.resolve(result);
    expect(await first).toBe(result);
    expect(await second).toBe(result);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('shares an overlapping rejection and releases the key for a later retry', async () => {
    const cache = createIdempotencyCache();
    const pending = deferred<unknown>();
    const fn = vi.fn<() => Promise<unknown>>(() => pending.promise);
    const first = cache.run('same', fn);
    const second = cache.run('same', fn);
    const error = new Error('write failed');
    const outcomes = Promise.allSettled([first, second]);
    pending.reject(error);
    const [firstOutcome, secondOutcome] = await outcomes;
    expect(firstOutcome).toStrictEqual({ status: 'rejected', reason: error });
    expect(secondOutcome).toStrictEqual({ status: 'rejected', reason: error });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(0);

    fn.mockResolvedValueOnce('retried');
    expect(await cache.run('same', fn)).toBe('retried');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps in-flight calls and expires success 60 seconds after completion', async () => {
    let clock = 0;
    const cache = createIdempotencyCache(undefined, () => clock);
    const pending = deferred<string>();
    const started = deferred<void>();
    const fn = vi.fn<() => Promise<string>>(() => {
      started.resolve();
      return pending.promise;
    });
    const first = cache.run('slow', fn);
    await started.promise;

    clock = 119_999;
    await cache.run('other', () => 'other'); // pruning must retain the in-flight call
    clock = 120_000;
    const second = cache.run('slow', fn);
    pending.resolve('done');
    expect(await first).toBe('done');
    expect(await second).toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);

    clock += 59_999;
    expect(await cache.run('slow', fn)).toBe('done');
    expect(fn).toHaveBeenCalledTimes(1);

    clock += 1;
    fn.mockResolvedValueOnce('fresh');
    expect(await cache.run('slow', fn)).toBe('fresh');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(1);
  });

  it('replays an abandoned call as its abandonment error for the TTL, then runs fresh', async () => {
    let clock = 0;
    const cache = createIdempotencyCache(undefined, () => clock);
    const pending = deferred<string>();
    const fn = vi.fn<() => Promise<string>>(() => pending.promise);
    const signal = new WriteSignal();
    void cache.run('stuck', fn, signal);
    await Promise.resolve();
    const abandoned = new WriteAbandonedError('set_text was abandoned after 27 s');
    signal.abandon(abandoned);

    // The retry answers with the abandonment error while the original is still pending.
    await expect(cache.run('stuck', fn)).rejects.toBe(abandoned);
    // A late success of the abandoned call does not become the cached result.
    pending.resolve('late');
    await Promise.resolve();
    clock = 59_999;
    await expect(cache.run('stuck', fn)).rejects.toBe(abandoned);
    expect(fn).toHaveBeenCalledTimes(1);

    clock = 60_000;
    fn.mockResolvedValueOnce('fresh');
    expect(await cache.run('stuck', fn)).toBe('fresh');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('runs overlapping different keys independently', async () => {
    const cache = createIdempotencyCache();
    const pending = deferred<string>();
    const started = deferred<void>();
    const firstFn = vi.fn<() => Promise<string>>(() => {
      started.resolve();
      return pending.promise;
    });
    const secondFn = vi.fn<() => string>(() => 'second');
    const first = cache.run('a', firstFn);
    await started.promise;

    expect(await cache.run('b', secondFn)).toBe('second');
    expect(firstFn).toHaveBeenCalledTimes(1);
    expect(secondFn).toHaveBeenCalledTimes(1);
    pending.resolve('first');
    expect(await first).toBe('first');
  });

  it('runs once per requestId and replays the cached result', async () => {
    const cache = createIdempotencyCache();
    const fn = vi.fn<() => Promise<{ token: number }>>(async () => ({ token: Math.random() }));
    const first = await cache.run('req-1', fn);
    const second = await cache.run('req-1', fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('runs separately for different requestIds', async () => {
    const cache = createIdempotencyCache();
    const fn = vi.fn<() => Promise<number>>(async () => 1);
    await cache.run('a', fn);
    await cache.run('b', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('never dedupes when requestId is undefined', async () => {
    const cache = createIdempotencyCache();
    const fn = vi.fn<() => Promise<number>>(async () => 1);
    await cache.run(undefined, fn);
    await cache.run(undefined, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('re-runs after the TTL expires and prunes stale entries', async () => {
    let clock = 1000;
    const cache = createIdempotencyCache(100, () => clock);
    const fn = vi.fn<() => Promise<number>>(async () => 1);
    await cache.run('x', fn);
    clock += 50;
    await cache.run('x', fn); // within TTL → cached
    expect(fn).toHaveBeenCalledTimes(1);
    clock += 100; // past TTL
    await cache.run('x', fn); // expired → re-run
    expect(fn).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(1);
  });
});

describe('idempotent wrapper', () => {
  it('applies a write once across 5 repeated calls with the same requestId', async () => {
    const cache = createIdempotencyCache();
    const applied = vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true }));
    const handler = idempotent(cache, applied);
    const results: unknown[] = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design (simulating retries)
      results.push(await handler({ requestId: 'w-1', nodeId: '1:2' }));
    }
    expect(applied).toHaveBeenCalledTimes(1);
    expect(results.every(r => r === results[0])).toBe(true);
  });

  it('runs every call when no requestId is present', async () => {
    const cache = createIdempotencyCache();
    const applied = vi.fn<() => Promise<number>>(async () => 1);
    const handler = idempotent(cache, applied);
    await handler({ nodeId: '1:2' });
    await handler({ nodeId: '1:2' });
    expect(applied).toHaveBeenCalledTimes(2);
  });
});
