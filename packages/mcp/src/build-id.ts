/**
 * Build timestamp (epoch ms) baked into the bundle by tsdown (see tsdown.config.ts `define`).
 * Newest-build-wins election orders server processes by it: a follower running a strictly newer
 * build asks a stale leader to abdicate (see election/election.ts), which is what keeps a
 * long-lived old process — another session's server, or one launched by hand — from serving stale
 * code forever. Published releases get their publish-time build stamp, so the ordering holds across
 * versions too, without parsing semver.
 *
 * When running unbundled (vitest, tsx) the define is absent and this is 0: an unbundled process
 * never claims to be newer than a real build, and two 0s never trigger an abdication.
 */
// eslint-disable-next-line no-underscore-dangle -- dunder marks a compile-time define, per convention
declare const __FIGWRIGHT_BUILD_ID__: string | undefined;

export const BUILD_ID: number =
  typeof __FIGWRIGHT_BUILD_ID__ === 'string' ? Number(__FIGWRIGHT_BUILD_ID__) : 0;

// Latest instant a JS Date can hold; a larger stamp has no calendar time to show.
const MAX_DATE_MS = 8.64e15;

/**
 * A build stamp as `ping` and `list_files` show it: the number with its UTC build time beside it.
 * Every build of one release reports the same version, so this is what tells two of them apart.
 * Undefined is a plugin older than build stamps, and 0 an unbundled build, which has no build
 * time.
 */
export const describeBuild = (buildId: number | undefined): string => {
  if (buildId === undefined) return 'unknown';
  if (buildId === 0) return '0 (unbundled)';
  return Number.isInteger(buildId) && buildId > 0 && buildId <= MAX_DATE_MS
    ? `${buildId} (${new Date(buildId).toISOString()})`
    : String(buildId);
};
