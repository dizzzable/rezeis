/**
 * Pure version → panel-shape derivation, shared by the two services that need
 * it and owned by neither.
 *
 * WHY IT IS ITS OWN FILE. `RemnawaveVersionService` already derived all of this,
 * but it is constructed WITH `RemnawaveApiService`, so the adapter cannot inject
 * it back without a dependency cycle — and the adapter is exactly what needs the
 * answer, because it is the thing building the paths. Lifting the derivation out
 * leaves both services importing a module with no dependencies of its own, and
 * keeps one definition of "which shape is this panel" rather than two that drift.
 */

/**
 * How the panel addresses a user inside its REST paths. Remnawave 2.x takes the
 * profile UUID (`/api/users/{uuid}`); 3.x renamed the parameter and takes the
 * numeric user id (`/api/users/{userId}`).
 *
 * `'unknown'` is not padding — it is the value the failure branch returns.
 * Version detection collapses every failure (401, timeout, DNS, unconfigured
 * token) into "no version", and a two-valued union would force a default that
 * addresses a live panel the wrong way for the whole cache window. Callers must
 * branch on `'unknown'` explicitly instead of guessing.
 */
export type RemnawaveUserAddressing = 'uuid' | 'id' | 'unknown';

/**
 * Which live-connection endpoint family the panel serves. 2.x exposes
 * `/api/ip-control/*`; 3.x dropped that family wholesale and replaced it with
 * `/api/connections/*`. `'unknown'` carries the same meaning as above.
 */
export type RemnawaveConnectionsApi = 'ip-control' | 'connections' | 'unknown';

/** Parses a `major.minor.patch` prefix from a version string. */
export function parseSemver(
  value: string | null,
): { major: number; minor: number; patch: number } | null {
  if (value === null) return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (match === null) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

/** Only 2.x and 3.x path shapes are known; anything else stays unknown. */
export function userAddressingFor(major: number): RemnawaveUserAddressing {
  if (major === 2) return 'uuid';
  if (major === 3) return 'id';
  return 'unknown';
}

/** Only 2.x and 3.x endpoint families are known; anything else stays unknown. */
export function connectionsApiFor(major: number): RemnawaveConnectionsApi {
  if (major === 2) return 'ip-control';
  if (major === 3) return 'connections';
  return 'unknown';
}

/**
 * The same derivation straight from a version string, for callers that hold one
 * and do not want to re-implement the parse-then-branch dance.
 * An unparseable or absent version yields `'unknown'`, never a guess.
 */
export function addressingForVersion(version: string | null): RemnawaveUserAddressing {
  const parsed = parseSemver(version);
  return parsed === null ? 'unknown' : userAddressingFor(parsed.major);
}

/** As {@link addressingForVersion}, for the live-connection family. */
export function connectionsApiForVersion(version: string | null): RemnawaveConnectionsApi {
  const parsed = parseSemver(version);
  return parsed === null ? 'unknown' : connectionsApiFor(parsed.major);
}

/** How long a successful detection is trusted before the panel is re-read. */
export const CAPABILITIES_CACHE_TTL_MS = 5 * 60_000;

/**
 * How long a *failed* detection is trusted. Every failure mode — 401, request
 * timeout, DNS, an unconfigured token, a panel mid-restart — collapses into the
 * same "no version" result, so caching it for the full five minutes turns a
 * one-second auth blip into a five-minute blackout of every version-gated
 * feature. Short enough to self-heal on the next page load, long enough that a
 * hard-down panel is not hammered.
 */
export const CAPABILITIES_NEGATIVE_CACHE_TTL_MS = 15_000;

/** A source of the panel's self-reported version. Both readers are optional. */
type VersionSource = () => Promise<{ readonly version?: unknown } | null>;

/**
 * Reads the panel version from `/api/system/stats/recap` (authoritative
 * `version` field on every tested build), falling back to the canonical 2.8
 * source `/api/system/metadata`. Returns `null` when the panel is unreachable
 * or omits the field.
 *
 * Takes the two readers rather than a service so that the adapter and the
 * capability service — which need the same answer but cannot depend on each
 * other — share one definition of the fallback ORDER. Getting that order wrong
 * in one of two copies is the kind of drift that only shows up on the one panel
 * build where the first source is missing.
 */
export async function readPanelVersionFrom(
  recap: VersionSource,
  metadata: VersionSource,
  onFailure?: (source: 'recap' | 'metadata', error: Error) => void,
): Promise<string | null> {
  for (const [name, read] of [
    ['recap', recap],
    ['metadata', metadata],
  ] as ReadonlyArray<readonly ['recap' | 'metadata', VersionSource]>) {
    try {
      const payload = await read();
      const version = payload?.version;
      if (typeof version === 'string' && version.length > 0) return version;
    } catch (err) {
      onFailure?.(name, err as Error);
    }
  }
  return null;
}
