import { createError, createResponse, ErrorCode } from '@figwright/shared';
import { describe, expect, it } from 'vitest';

import type { Follower } from '../../src/election/follower.js';
import { portConflictMessage } from '../../src/election/leader-lock.js';
import { type Node, NodeRole } from '../../src/election/node.js';
import { handlePing, pingTool } from '../../src/tools/ping.js';
import { fakeRelay } from '../relay-fake.js';
import { toToolDefinition } from '../tool-schema.js';

const pingToolDefinition = toToolDefinition(pingTool);

const makeNode = (overrides: Partial<Node> & { role?: NodeRole }): Node =>
  ({
    isConflicted: () => false,
    port: 3055,
    conflictMessage: portConflictMessage(3055),
    // dispatch subscribes to role changes so a conflict declared mid-call can cut it short.
    onRoleChange: () => () => {},
    ...overrides,
  }) as unknown as Node;
const makeFollower = (overrides: Partial<Follower>): Follower => overrides as unknown as Follower;

describe('ping tool', () => {
  it('names the failed plugin route in the server-only fallback', async () => {
    const { relay, connect } = fakeRelay();
    const plugin = connect('session-a', 'Draft α');
    const node = makeNode({
      role: NodeRole.Leader,
      isLeader: () => true,
      getLeader: () => ({ relay }) as unknown as ReturnType<Node['getLeader']>,
    });
    try {
      const result = handlePing({ node, follower: makeFollower({}), serverVersion: '1.0.0' });
      const request = await plugin.request;
      plugin.receive(
        createError({
          id: request.id,
          sessionId: 'session-a',
          code: ErrorCode.Internal,
          message: 'unavailable',
        }),
      );
      const answer = await result;
      expect(answer.hop).toBe('server-only');
      expect(answer.dispatchError).toContain('answered by session session-a, file "Draft α"');
    } finally {
      await relay.stop();
    }
  });
  it('exposes a valid MCP tool definition', () => {
    expect(pingToolDefinition.name).toBe('ping');
    expect(pingToolDefinition.inputSchema.type).toBe('object');
  });

  it('returns server-only hop when leader has no plugin connected', async () => {
    const node = makeNode({
      role: NodeRole.Leader,
      isLeader: () => true,
      getLeader: () =>
        ({
          port: 3055,
          relay: { sessions: { connected: () => [] } },
          http: undefined as never,
        }) as unknown as ReturnType<Node['getLeader']>,
    });
    const result = await handlePing({
      node,
      follower: makeFollower({}),
      serverVersion: '1.0.0',
    });
    expect(result.ok).toBe(true);
    expect(result.hop).toBe('server-only');
    expect(result.plugin).toBeNull();
    expect(result.server.version).toBe('1.0.0');
    expect(result.server.role).toBe(NodeRole.Leader);
    expect(result.server.port).toBe(3055);
    expect(result.sessions?.connectedCount).toBe(0);
  });

  it('surfaces a portConflict warning when the node is conflicted', async () => {
    const node = makeNode({
      role: NodeRole.Conflicted,
      isLeader: () => false,
      isConflicted: () => true,
      port: 3055,
      getLeader: () => null,
      conflictMessage: portConflictMessage(3055, {
        pid: 4242,
        buildId: 1,
        serverVersion: '0.4.0',
        stopped: false,
        resumed: false,
      }),
    });
    const result = await handlePing({
      node,
      follower: makeFollower({}),
      serverVersion: '1.0.0',
    });
    expect(result.hop).toBe('server-only');
    expect(result.plugin).toBeNull();
    expect(result.server.role).toBe(NodeRole.Conflicted);
    // Reports the election's diagnosis verbatim, pid included — `ping` is where a user looks when
    // nothing works, so it must name the process to kill rather than restate the symptom.
    expect(result.server.portConflict).toMatch(/pid 4242/);
    expect(result.server.portConflict).toMatch(/kill 4242/);
  });

  it('returns e2e hop with plugin info + sessions when dispatch succeeds (leader path)', async () => {
    const pluginInfo = { apiVersion: '1.0.0', currentPageId: 'p1' };
    const sessA = {
      id: 'sess-a',
      fileName: 'Design A',
      pageName: 'Mockup',
      lastActivityAt: 1000,
    };
    const sessB = {
      id: 'sess-b',
      fileName: 'Design B',
      pageName: 'Cover',
      lastActivityAt: 2000,
    };
    const node = makeNode({
      role: NodeRole.Leader,
      isLeader: () => true,
      getLeader: () =>
        ({
          port: 3055,
          relay: {
            sessions: { connected: () => [sessA, sessB] },
            pickActiveSession: () => sessB,
            skewNotice: () => null,
            sendRequest: async () => pluginInfo,
          },
          http: undefined as never,
        }) as unknown as ReturnType<Node['getLeader']>,
    });
    const result = await handlePing({
      node,
      follower: makeFollower({}),
      serverVersion: '1.0.0',
    });
    expect(result.hop).toBe('e2e');
    expect(result.plugin).toEqual(pluginInfo);
    expect(result.sessions?.connectedCount).toBe(2);
    expect(result.sessions?.routedSessionId).toBe('sess-b');
    expect(result.sessions?.routedFileName).toBe('Design B');
    expect(result.sessions?.routedPageName).toBe('Cover');
    // All sessions sorted newest-active first.
    expect(result.sessions?.all.map(s => s.id)).toEqual(['sess-b', 'sess-a']);
  });

  describe('which build each half runs', () => {
    // 2025-11-09T00:00:00Z and the day after, as epoch ms.
    const NOV_9 = 1_762_646_400_000;
    const NOV_10 = 1_762_732_800_000;

    /** Ping a real relay, answering the plugin request on whichever session routing picked. */
    const pingRelay = async (
      buildId: number | undefined,
      plugins: readonly { id: string; clientBuildId?: number }[],
    ): Promise<Awaited<ReturnType<typeof handlePing>>> => {
      const { relay, connect } = fakeRelay();
      const node = makeNode({
        role: NodeRole.Leader,
        isLeader: () => true,
        getLeader: () => ({ relay }) as unknown as ReturnType<Node['getLeader']>,
      });
      try {
        const connected = plugins.map(p => connect(p.id, `File ${p.id}`, null, p.clientBuildId));
        const result = handlePing({
          node,
          follower: makeFollower({}),
          serverVersion: '1.0.0',
          ...(buildId === undefined ? {} : { buildId }),
        });
        const request = await Promise.race(connected.map(c => c.request));
        connected
          .find(c => c.sent.includes(request))!
          .receive(createResponse({ id: request.id, sessionId: request.sessionId, result: {} }));
        return await result;
      } finally {
        await relay.stop();
      }
    };

    it('names each session’s plugin build when two files run different builds', async () => {
      const result = await pingRelay(NOV_10, [
        { id: 'sess-a', clientBuildId: NOV_9 },
        { id: 'sess-b', clientBuildId: NOV_10 },
      ]);

      expect(result.hop).toBe('e2e');
      expect(result.server.buildId).toBe(NOV_10);
      expect(result.server.build).toBe('1762732800000 (2025-11-10T00:00:00.000Z)');
      expect(Object.fromEntries(result.sessions!.all.map(s => [s.id, s.pluginBuild]))).toEqual({
        'sess-a': '1762646400000 (2025-11-09T00:00:00.000Z)',
        'sess-b': '1762732800000 (2025-11-10T00:00:00.000Z)',
      });
    });

    it('shows a plugin older than the build id as unknown', async () => {
      const result = await pingRelay(NOV_10, [{ id: 'sess-old' }]);

      expect(result.sessions!.all).toEqual([expect.objectContaining({ pluginBuild: 'unknown' })]);
    });

    it('says an unbundled server (build id 0) is unbundled rather than a 1970 date', async () => {
      const result = await pingRelay(undefined, [{ id: 'sess-a', clientBuildId: 0 }]);

      expect(result.server.buildId).toBe(0);
      expect(result.server.build).toBe('0 (unbundled)');
      expect(result.sessions!.all[0]!.pluginBuild).toBe('0 (unbundled)');
    });
  });

  it('falls back to server-only when dispatch throws (follower path)', async () => {
    const node = makeNode({
      role: NodeRole.Follower,
      isLeader: () => false,
      getLeader: () => null,
    });
    const follower = makeFollower({
      leaderInfo: async () => ({ serverVersion: '1.0.0', buildId: 0 }),
      sendRpc: async () => ({
        kind: 'err' as const,
        requestId: 'r',
        code: 'PLUGIN_DISCONNECTED',
        message: 'no plugin connected',
      }),
    });
    const result = await handlePing({
      node,
      follower,
      serverVersion: '1.0.0',
      log: () => {},
    });
    expect(result.hop).toBe('server-only');
    expect(result.plugin).toBeNull();
    expect(result.dispatchError).toContain('no plugin connected');
    expect(result.server.role).toBe(NodeRole.Follower);
    expect(result.server.port).toBeNull();
  });

  it('flags a leader/follower version skew (zombie-leader trap)', async () => {
    const node = makeNode({
      role: NodeRole.Follower,
      isLeader: () => false,
      getLeader: () => null,
    });
    const follower = makeFollower({
      // stale older leader still owns the plugin
      leaderInfo: async () => ({ serverVersion: '0.1.0', buildId: 100 }),
      sendRpc: async () => ({
        kind: 'ok' as const,
        requestId: 'r',
        result: { apiVersion: '1.0.0' },
      }),
    });
    const result = await handlePing({
      node,
      follower,
      serverVersion: '0.2.0',
      buildId: 200,
      log: () => {},
    });

    expect(result.server.version).toBe('0.2.0');
    expect(result.server.leaderVersion).toBe('0.1.0');
    expect(result.server.versionSkew).toMatch(/leader is v0\.1\.0.*v0\.2\.0/);
    // An older version implies an older build, so both warnings fire; buildSkew explains the
    // auto-heal (abdication) and the manual fallback.
    expect(result.server.leaderBuildId).toBe(100);
    expect(result.server.buildSkew).toMatch(/older build/);
  });

  it('flags a build skew alone when versions match but the leader build is older', async () => {
    const node = makeNode({
      role: NodeRole.Follower,
      isLeader: () => false,
      getLeader: () => null,
    });
    const follower = makeFollower({
      // Same released version, older local build — the dev-iteration zombie ping must expose.
      leaderInfo: async () => ({ serverVersion: '0.2.0', buildId: 100 }),
      sendRpc: async () => ({
        kind: 'ok' as const,
        requestId: 'r',
        result: { apiVersion: '1.0.0' },
      }),
    });
    const result = await handlePing({
      node,
      follower,
      serverVersion: '0.2.0',
      buildId: 200,
      log: () => {},
    });

    expect(result.server.versionSkew).toBeUndefined();
    expect(result.server.buildSkew).toMatch(/older build/);
    expect(result.server.buildSkew).toMatch(/lsof -iTCP:3055/);
  });

  it('reports leaderVersion with no skew warning when versions match', async () => {
    const node = makeNode({
      role: NodeRole.Follower,
      isLeader: () => false,
      getLeader: () => null,
    });
    const follower = makeFollower({
      leaderInfo: async () => ({ serverVersion: '0.2.0', buildId: 200 }),
      sendRpc: async () => ({
        kind: 'ok' as const,
        requestId: 'r',
        result: { apiVersion: '1.0.0' },
      }),
    });
    const result = await handlePing({
      node,
      follower,
      serverVersion: '0.2.0',
      buildId: 200,
      log: () => {},
    });

    expect(result.server.leaderVersion).toBe('0.2.0');
    expect(result.server.versionSkew).toBeUndefined();
    expect(result.server.buildSkew).toBeUndefined();
  });

  it('omits leaderVersion when the leader version is unreachable', async () => {
    const node = makeNode({
      role: NodeRole.Follower,
      isLeader: () => false,
      getLeader: () => null,
    });
    const follower = makeFollower({
      leaderInfo: async () => undefined,
      sendRpc: async () => ({
        kind: 'ok' as const,
        requestId: 'r',
        result: { apiVersion: '1.0.0' },
      }),
    });
    const result = await handlePing({ node, follower, serverVersion: '0.2.0', log: () => {} });

    expect(result.server.leaderVersion).toBeUndefined();
    expect(result.server.versionSkew).toBeUndefined();
    expect(result.server.buildSkew).toBeUndefined();
  });
});
