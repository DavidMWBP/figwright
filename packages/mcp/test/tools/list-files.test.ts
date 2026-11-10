import type { ListFilesResult } from '@figwright/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginSessionInfo } from '../../src/routing/sessions.js';
import { clearFileTarget, setFileTarget } from '../../src/routing/target.js';
import { handleListFiles, type SessionDispatch } from '../../src/tools/list-files.js';

const session = (
  id: string,
  fileName: string | null,
  pageName: string | null = 'Page 1',
): PluginSessionInfo => ({ id, fileName, pageName, lastActivityAt: 1, pluginVersion: '0.5.0' });

/** Answers each session with the file name it is keyed by; anything not listed throws. */
const replying =
  (byId: Record<string, string>): SessionDispatch =>
  async (sessionId): Promise<ListFilesResult> => {
    const fileName = byId[sessionId];
    if (fileName === undefined) throw new Error(`plugin request timeout (session=${sessionId})`);
    return { files: [{ fileKey: null, fileName, currentPage: { id: 'p1', name: 'Page 1' } }] };
  };

afterEach(() => {
  clearFileTarget();
});

describe('handleListFiles', () => {
  it('asks every connected session, marking the routed one', async () => {
    // Sessions arrive newest-activity-first, so the head is where an unbound call would land.
    const { files } = await handleListFiles(
      [session('s-1', 'Brand'), session('s-2', 'Marketing')],
      replying({ 's-1': 'Brand', 's-2': 'Marketing' }),
    );
    expect(files.map(f => [f.sessionId, f.fileName, f.routed, f.bound])).toEqual([
      ['s-1', 'Brand', true, false],
      ['s-2', 'Marketing', false, false],
    ]);
  });

  it('marks the claimed file', async () => {
    setFileTarget({ sessionId: 's-2', fileName: 'Marketing' });
    const { files } = await handleListFiles(
      [session('s-1', 'Brand'), session('s-2', 'Marketing')],
      replying({ 's-1': 'Brand', 's-2': 'Marketing' }),
    );
    // Claimed and routed are different facts, and the whole feature is the case where they differ.
    expect(files.map(f => [f.sessionId, f.routed, f.bound])).toEqual([
      ['s-1', true, false],
      ['s-2', false, true],
    ]);
  });

  it('fills in a name the server never learned by asking the plugin', async () => {
    // A panel opened in a background tab has emitted no $activity, so the relay's cached name is
    // null — and that is precisely the session a second agent is looking for.
    const { files } = await handleListFiles(
      [session('s-2', null, null)],
      replying({ 's-2': 'Hidden' }),
    );
    expect(files[0]?.fileName).toBe('Hidden');
    expect(files[0]?.error).toBeUndefined();
  });

  it('flags duplicate names, ignoring case', async () => {
    const { files } = await handleListFiles(
      [session('s-1', 'Brand'), session('s-2', 'brand'), session('s-3', 'Other')],
      replying({ 's-1': 'Brand', 's-2': 'brand', 's-3': 'Other' }),
    );
    expect(files.map(f => f.duplicateName)).toEqual([true, true, undefined]);
  });

  it('keeps listing the other files when one plugin does not answer', async () => {
    // One wedged panel must not hide the file the agent is trying to find.
    const { files } = await handleListFiles(
      [session('s-1', 'Brand'), session('s-2', 'Marketing')],
      replying({ 's-1': 'Brand' }),
    );
    expect(files[0]).toMatchObject({ fileName: 'Brand' });
    // Falls back to what the relay last heard, and says why it is second-hand.
    expect(files[1]).toMatchObject({ fileName: 'Marketing' });
    expect(files[1]?.error).toMatch(/timeout/);
  });

  it('is two empty lists when no plugin is connected or reconnecting', async () => {
    expect(await handleListFiles([], replying({}), [], undefined, 0)).toEqual({
      serverBuild: '0 (unbundled)',
      files: [],
      reconnecting: [],
    });
  });

  it('names the server build and each file’s plugin build, unknown for an older plugin', async () => {
    const result = await handleListFiles(
      [
        { ...session('s-1', 'Brand'), pluginBuildId: 1_762_646_400_000 },
        session('s-2', 'Marketing'),
      ],
      replying({ 's-1': 'Brand', 's-2': 'Marketing' }),
      [],
      undefined,
      1_762_732_800_000,
    );

    expect(result.serverBuild).toBe('1762732800000 (2025-11-10T00:00:00.000Z)');
    expect(result.files.map(f => [f.sessionId, f.pluginBuild])).toEqual([
      ['s-1', '1762646400000 (2025-11-09T00:00:00.000Z)'],
      ['s-2', 'unknown'],
    ]);
  });

  it('says the leader is unreachable, and why, instead of only listing nothing', async () => {
    const reason = '/ping to http://127.0.0.1:3055 failed: fetch failed';
    expect(await handleListFiles([], replying({}), [], reason)).toEqual({
      serverBuild: 'unknown',
      files: [],
      reconnecting: [],
      leaderUnreachable: reason,
    });
  });

  it('lists a dropped session apart from the connected one, with how long ago and why', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 10, 9, 12, 0, 12));
      const asked: string[] = [];
      const dispatch: SessionDispatch = async (sessionId, ...rest) => {
        asked.push(sessionId);
        return replying({ 's-1': 'Brand' })(sessionId, ...rest);
      };
      const reason = { code: 1001, closedBy: 'server', detail: 'heartbeat timeout' } as const;

      const result = await handleListFiles([session('s-1', 'Brand')], dispatch, [
        {
          id: 's-2',
          fileName: 'Marketing',
          pageName: 'Cover',
          pluginVersion: '0.5.0',
          disconnectedAt: Date.UTC(2026, 10, 9, 12, 0, 5),
          reason,
        },
      ]);

      // The dropped one is not a file calls can reach, so it is neither asked nor routed to.
      expect(asked).toEqual(['s-1']);
      expect(result.files.map(f => [f.sessionId, f.routed])).toEqual([['s-1', true]]);
      expect(result.reconnecting).toEqual([
        {
          sessionId: 's-2',
          fileName: 'Marketing',
          pageName: 'Cover',
          pluginVersion: '0.5.0',
          droppedMsAgo: 7_000,
          reason,
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
