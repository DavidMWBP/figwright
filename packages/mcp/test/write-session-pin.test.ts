import { EventEmitter } from 'node:events';

import { createResponse, decodeEnvelope } from '@figwright/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchTargeted, dispatchTool, resetRoutingNoticeCache } from '../src/dispatch.js';
import { Follower, type FetchFn } from '../src/election/follower.js';
import { attachLeaderEndpoints } from '../src/election/leader-endpoints.js';
import type { Node } from '../src/election/node.js';
import { clearFileTarget, setFileTarget } from '../src/routing/target.js';
import { fakeRelay } from './relay-fake.js';

const cleanups: (() => Promise<void>)[] = [];
const write = { nodeId: '1:2', name: 'Updated', requestId: 'logical-write' };

// Only sockets and HTTP transport are fake: routing, envelopes, leader endpoints and the follower
// run unchanged. Nothing listens on a port, and a dropped reply happens after the plugin answered.
const leader = () => {
  const fixture = fakeRelay();
  const detach = attachLeaderEndpoints(fixture.http, {
    relay: fixture.relay,
    serverVersion: '1.0.0',
  });
  cleanups.push(async () => {
    detach();
    await fixture.relay.stop();
  });
  const deliveries: { sessionId: string; method: string; params: unknown }[] = [];
  for (const id of ['session-a', 'session-b']) {
    const plugin = fixture.connect(id, 'Same file');
    const send = plugin.socket.send.bind(plugin.socket);
    vi.spyOn(plugin.socket, 'send').mockImplementation(bytes => {
      send(bytes);
      const env = decodeEnvelope(bytes as Uint8Array);
      if (env.kind !== 'req' || env.method.startsWith('$')) return;
      deliveries.push({ sessionId: id, method: env.method, params: env.params });
      plugin.receive(createResponse({ id: env.id, sessionId: id, result: { served: id } }));
    });
  }
  const activate = (id: string) => {
    for (const session of fixture.relay.sessions.connected()) {
      session.lastActivityAt = session.id === id ? 2 : 1;
    }
  };
  activate('session-a');
  return { ...fixture, deliveries, activate };
};

const harness = () => {
  let current = leader();
  let localLeader = false;
  let pingCount = 0;
  let rpcCount = 0;
  let repliesToDrop = 1;
  let afterLostReply = () => current.activate('session-b');
  let pingUnavailable = false;
  let retrying = () => {};
  const retry = new Promise<void>(resolve => {
    retrying = resolve;
  });
  const fetch: FetchFn = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/ping') {
      pingCount += 1;
      if (pingUnavailable) throw new TypeError('fetch failed');
    } else {
      rpcCount += 1;
    }
    const drop = path === '/rpc' && rpcCount <= repliesToDrop;
    return new Promise<Response>((resolve, reject) => {
      const req = Object.assign(new EventEmitter(), {
        method: init?.method ?? 'GET',
        url: path,
        headers: { host: '127.0.0.1:0', ...init?.headers },
      });
      let status = 200;
      const res = {
        writeHead: (code: number) => {
          status = code;
        },
        end: (body: string | Uint8Array) => {
          if (drop) {
            afterLostReply();
            reject(new TypeError('fetch failed'));
          } else {
            resolve(new Response(typeof body === 'string' ? body : Buffer.from(body), { status }));
          }
        },
      };
      current.http.emit('request', req, res);
      if (init?.body !== undefined) req.emit('data', Buffer.from(init.body as Uint8Array));
      req.emit('end');
    });
  };
  const follower = new Follower({ leaderUrl: 'http://127.0.0.1:0', fetch });
  const node = {
    isConflicted: () => false,
    isLeader: () => localLeader,
    getLeader: () => ({ relay: current.relay }),
    onRoleChange: () => () => {},
  } as unknown as Node;
  const ctx = { node, follower, log: () => retrying() };
  return {
    ctx,
    first: current,
    retry,
    pingCount: () => pingCount,
    rpcCount: () => rpcCount,
    onLostReply: (fn: () => void) => {
      afterLostReply = fn;
    },
    replaceLeader: (next: ReturnType<typeof leader>, local = false) => {
      current = next;
      localLeader = local;
    },
    failPing: () => {
      pingUnavailable = true;
    },
    dropReplies: (count: number) => {
      repliesToDrop = count;
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  clearFileTarget();
  resetRoutingNoticeCache();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearFileTarget();
});

describe('follower write session pin', () => {
  it('retries a write on the session it first went to', async () => {
    const h = harness();
    const call = dispatchTool(h.ctx, 'rename_node', write);
    await h.retry;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await call).toEqual({ served: 'session-a' });
    expect(h.first.deliveries).toEqual([
      { sessionId: 'session-a', method: 'rename_node', params: write },
      { sessionId: 'session-a', method: 'rename_node', params: write },
    ]);
    expect(h.pingCount()).toBe(1);
  });

  it('names the disconnected first session and never delivers to B', async () => {
    const h = harness();
    h.onLostReply(() => {
      h.first.activate('session-b');
      h.first.relay.sessions.end(h.first.relay.sessions.get('session-a')!);
    });
    const call = dispatchTool(h.ctx, 'rename_node', write).catch(e => e);
    await h.retry;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await call).toMatchObject({
      code: 'PLUGIN_DISCONNECTED',
      message: expect.stringContaining('session-a'),
    });
    expect(h.first.deliveries.map(d => d.sessionId)).toEqual(['session-a']);
  });

  it.each([false, true])('keeps the pin when leadership changes (local=%s)', async local => {
    const h = harness();
    const next = leader();
    next.activate('session-b');
    h.onLostReply(() => h.replaceLeader(next, local));
    const call = dispatchTool(h.ctx, 'rename_node', write);
    await h.retry;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await call).toEqual({ served: 'session-a' });
    expect(h.first.deliveries.map(d => d.sessionId)).toEqual(['session-a']);
    expect(next.deliveries.map(d => d.sessionId)).toEqual(['session-a']);
    expect(h.pingCount()).toBe(1);
  });

  it('keeps per-attempt active routing for a retried read', async () => {
    const h = harness();
    const call = dispatchTool(h.ctx, 'get_node', { nodeId: '1:2' });
    await h.retry;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await call).toEqual({ served: 'session-b' });
    expect(h.first.deliveries.map(d => d.sessionId)).toEqual(['session-a', 'session-b']);
    expect(h.pingCount()).toBe(0);
  });

  it('keeps a claimed file pinned without resolving activity', async () => {
    const h = harness();
    h.first.activate('session-b');
    setFileTarget({ sessionId: 'session-a', fileName: 'Same file' });
    const call = dispatchTargeted(h.ctx, 'rename_node', write);
    await h.retry;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await call).toEqual({ served: 'session-a' });
    expect(h.first.deliveries.map(d => d.sessionId)).toEqual(['session-a', 'session-a']);
    expect(h.pingCount()).toBe(0);
  });

  it('keeps an explicit pin without resolving activity', async () => {
    const h = harness();
    h.first.activate('session-b');
    const call = dispatchTool(h.ctx, 'rename_node', write, { sessionId: 'session-a' });
    await h.retry;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await call).toEqual({ served: 'session-a' });
    expect(h.first.deliveries.map(d => d.sessionId)).toEqual(['session-a', 'session-a']);
    expect(h.pingCount()).toBe(0);
  });

  it('names the pinned session when every transport reply is lost', async () => {
    const h = harness();
    h.dropReplies(3);
    const call = dispatchTool(h.ctx, 'rename_node', write).catch(e => e);
    await h.retry;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await call).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: expect.stringMatching(/follower rpc transport:.*session-a/),
    });
    expect(h.first.deliveries.map(d => d.sessionId)).toEqual([
      'session-a',
      'session-a',
      'session-a',
    ]);
    expect(h.pingCount()).toBe(1);
  });

  it('says the write outcome is unknown and names its tool, session and requestId', async () => {
    const h = harness();
    h.dropReplies(3);
    const call = dispatchTool(h.ctx, 'rename_node', write).catch(e => e);
    await h.retry;
    await vi.advanceTimersByTimeAsync(3_000);
    const { message } = (await call) as Error;
    expect(message).toMatch(/^follower rpc transport: fetch failed/);
    expect(message).toContain('outcome unknown, read back before retrying');
    expect(message).toContain('rename_node');
    expect(message).toContain('session-a');
    expect(message).toContain('logical-write');
  });

  it('leaves leader-direct writes on the active session without resolving or retrying', async () => {
    const h = harness();
    h.first.activate('session-b');
    h.replaceLeader(h.first, true);
    await expect(dispatchTool(h.ctx, 'rename_node', write)).resolves.toEqual({
      served: 'session-b',
    });
    // An ended session makes the real direct relay reject; no follower retry may be attempted.
    h.first.relay.sessions.end(h.first.relay.sessions.get('session-b')!);
    await expect(
      dispatchTool(h.ctx, 'rename_node', write, { sessionId: 'session-b' }),
    ).rejects.toThrow('session-b');
    expect(h.first.deliveries.map(d => d.sessionId)).toEqual(['session-b']);
    expect(h.pingCount()).toBe(0);
    expect(h.rpcCount()).toBe(0);
  });

  it.each(['unreachable', 'empty'])(
    'refuses an unpinned write when resolution is %s',
    async state => {
      const h = harness();
      if (state === 'unreachable') h.failPing();
      else h.first.relay.sessions.clear();
      await expect(dispatchTool(h.ctx, 'rename_node', write)).rejects.toThrow(/session/i);
      expect(h.rpcCount()).toBe(0);
      expect(h.first.deliveries).toEqual([]);
    },
  );
});
