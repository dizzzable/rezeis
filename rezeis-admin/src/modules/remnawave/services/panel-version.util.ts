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

/**
 * ONE reading of which era the panel is, taken at a single point in time and
 * then carried BY VALUE through every step that depends on it.
 *
 * WHY A VALUE AND NOT A SECOND CALL. `getPanelShape()` is cached, and the
 * failure cache is fifteen seconds ({@link CAPABILITIES_NEGATIVE_CACHE_TTL_MS}),
 * so two reads taken microseconds apart can legitimately disagree: the first
 * can be served from a negative entry that expires before the second, and the
 * second can come back with a real version. Two consumers that each read for
 * themselves therefore "usually agree" — which on a delete path is the whole
 * defect, because the consumer that decides WHETHER to delete and the consumer
 * that decides WHAT ADDRESS to delete are then answering about different
 * panels. A stored 2.x uuid assessed against `'unknown'` (proceed: the address
 * builder will emit the stored string and the panel will answer 400) and then
 * addressed against `'id'` (fall back through `panelId`/short uuid/username)
 * resolves to a LIVE profile and deletes it.
 *
 * So the era stops being something callers ask for and becomes something they
 * HOLD. It is threaded into the destructive adapter methods as a required
 * argument, which is what makes "the same value" a compile-time property
 * rather than a convention.
 */
export interface PanelEraObservation {
  readonly addressing: RemnawaveUserAddressing;
}

/**
 * Takes that one reading.
 *
 * A THROW IS THE UNKNOWN ERA, not an error to propagate — the same rule
 * `getPanelShape()` already applies internally, restated here because this is
 * the entry point a caller wired without a working adapter reaches. The job of
 * this function is to answer which era the panel is; it must never become a
 * second way for a deletion to fail.
 */
export async function observePanelEra(
  readPanelShape: () => Promise<{ readonly addressing: RemnawaveUserAddressing }>,
): Promise<PanelEraObservation> {
  try {
    return { addressing: (await readPanelShape()).addressing };
  } catch {
    return { addressing: 'unknown' };
  }
}

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
