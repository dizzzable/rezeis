import { Injectable, Logger } from '@nestjs/common';

import { RemnawaveApiService } from './remnawave-api.service';

/**
 * How the panel addresses a user inside its REST paths. Remnawave 2.x takes
 * the profile UUID (`/api/users/{uuid}`); 3.x renamed the parameter and takes
 * the user id (`/api/users/{userId}`).
 *
 * `'unknown'` is not padding — it is the value the failure branch returns.
 * Version detection collapses every failure (401, timeout, DNS, unconfigured
 * token) into "no version", and a two-valued union would force a default that
 * addresses a live panel the wrong way for the whole cache window. Callers
 * must branch on `'unknown'` explicitly instead of guessing.
 */
export type RemnawaveUserAddressing = 'uuid' | 'id' | 'unknown';

/**
 * Which live-connection endpoint family the panel serves. 2.x exposes
 * `/api/ip-control/*`; 3.x dropped that family wholesale and replaced it with
 * `/api/connections/*`. `'unknown'` carries the same meaning as on
 * {@link RemnawaveUserAddressing} — detection failed, do not guess.
 */
export type RemnawaveConnectionsApi = 'ip-control' | 'connections' | 'unknown';

/**
 * Direct user-lookup shortcuts (`/api/users/by-telegram-id/{id}`,
 * `/api/users/by-email/{email}`). Present on 2.7 and 2.8, gone on 3.x, which
 * keeps only short-uuid / username lookups. `false` means "route through the
 * generic resolve path", so the unknown case is safe rather than ambiguous.
 */
export interface RemnawaveUserLookups {
  readonly byTelegramId: boolean;
  readonly byEmail: boolean;
}

/**
 * Detected Remnawave panel version + the capability facts rezeis derives from
 * it. `supported` tells the admin SPA whether to show a "compatible" or an
 * "untested version" banner; the rest let the app light up (or stand down
 * from) version-specific behaviour automatically once a panel upgrades,
 * without a redeploy or a manual toggle:
 *   • `liveIpControl`        — `/api/ip-control/*` matured enough to drive the
 *                              Live tab and the IP-sharing detector (2.8.x).
 *   • `bandwidthNodesUsers`  — `POST /api/bandwidth-stats/nodes/users`.
 *   • `userAddressing`       — uuid- vs id-addressed user paths.
 *   • `connectionsApi`       — which live-connection family exists.
 *   • `userLookups`          — which by-telegram-id / by-email shortcuts exist.
 *
 * The three latter fields are descriptive only: nothing consumes them yet, and
 * adding them does not enable any 3.x behaviour. They exist so the eventual
 * one-build-drives-2.7.4/2.8.0/3.2.1 work has a single place to read the panel
 * shape from, with an explicit "we do not know" state.
 */
export interface RemnawaveCapabilities {
  readonly version: string | null;
  readonly major: number | null;
  readonly minor: number | null;
  readonly patch: number | null;
  /** True when the detected `major.minor` is in the tested set (see below). */
  readonly supported: boolean;
  /** True when the panel responded at all (version could be read). */
  readonly reachable: boolean;
  readonly liveIpControl: boolean;
  readonly bandwidthNodesUsers: boolean;
  readonly userAddressing: RemnawaveUserAddressing;
  readonly connectionsApi: RemnawaveConnectionsApi;
  readonly userLookups: RemnawaveUserLookups;
}

/**
 * `major.minor` releases rezeis has actually been tested against — an explicit
 * set, deliberately not an ordered range. A range (`>= 2.7`) would silently
 * stop warning the operator on 2.9 / 2.10 / 2.11 / 3.0 / 3.1, none of which
 * anybody has run; the banner is the only signal an operator gets before an
 * untested panel starts returning shapes rezeis does not parse.
 *
 * `'3.2'` is intentionally absent: it joins this set only when the whole
 * three-version (2.7.4 / 2.8.0 / 3.2.1) effort lands, not when the groundwork
 * does. Whatever this set says has to stay true of the operator-facing prose
 * in `web/src/i18n/features/remnawave.{en,ru}.ts` →
 * `remnaWavePage.versionWarning.description`, which spells the range out.
 */
const TESTED_VERSIONS: ReadonlySet<string> = new Set(['2.7', '2.8']);

/** How long a successful detection is trusted before the panel is re-read. */
export const CAPABILITIES_CACHE_TTL_MS = 5 * 60_000;

/**
 * How long a *failed* detection is trusted. Every failure mode — 401, request
 * timeout, DNS, an unconfigured token, a panel mid-restart — collapses into
 * the same all-false / `'unknown'` result, so caching it for the full five
 * minutes turns a one-second auth blip into a five-minute blackout of every
 * version-gated feature. Short enough to self-heal on the next page load, long
 * enough that a hard-down panel is not hammered.
 */
export const CAPABILITIES_NEGATIVE_CACHE_TTL_MS = 15_000;

@Injectable()
export class RemnawaveVersionService {
  private readonly logger = new Logger(RemnawaveVersionService.name);
  private cache: { value: RemnawaveCapabilities; at: number; ttlMs: number } | null = null;

  public constructor(private readonly api: RemnawaveApiService) {}

  /**
   * Returns cached capabilities, refreshing past the TTL — the short negative
   * TTL when the last detection failed, the long one when it succeeded.
   *
   * `force` skips the cache entirely. It is reachable over HTTP as
   * `GET /admin/remnawave/version?force=true` so an operator who has just
   * fixed a token or brought the panel back can clear a bad cached state
   * without restarting the container.
   */
  public async getCapabilities(force = false): Promise<RemnawaveCapabilities> {
    const now = Date.now();
    if (!force && this.cache !== null && now - this.cache.at < this.cache.ttlMs) {
      return this.cache.value;
    }
    const value = await this.detect();
    this.cache = { value, at: now, ttlMs: cacheTtlFor(value) };
    return value;
  }

  private async detect(): Promise<RemnawaveCapabilities> {
    const version = await this.readVersion();
    const parsed = parseSemver(version);
    if (parsed === null) {
      return {
        version,
        major: null,
        minor: null,
        patch: null,
        supported: false,
        reachable: version !== null,
        liveIpControl: false,
        bandwidthNodesUsers: false,
        userAddressing: 'unknown',
        connectionsApi: 'unknown',
        userLookups: { byTelegramId: false, byEmail: false },
      };
    }
    const { major, minor, patch } = parsed;
    return {
      version,
      major,
      minor,
      patch,
      supported: TESTED_VERSIONS.has(`${major}.${minor}`),
      reachable: true,
      // 2.8.x ONLY, not "2.8 or newer": 3.x deleted the whole `ip-control/*`
      // family (it became `connections/*`), so a `>= 2.8` test would point the
      // IP-sharing detector and the Live tab at endpoints a 3.x panel answers
      // with 404. Widen this again — to `connectionsApi !== 'unknown'` — once
      // the `connections/*` family is actually wired up.
      liveIpControl: major === 2 && minor >= 8,
      // `POST /api/bandwidth-stats/nodes/users` is absent on 2.7.4 and present
      // on both 2.8.0 and 3.2.1, so this one really is "2.8 or newer".
      bandwidthNodesUsers: major > 2 || (major === 2 && minor >= 8),
      userAddressing: userAddressingFor(major),
      connectionsApi: connectionsApiFor(major),
      // Both shortcuts exist on 2.7.4 and 2.8.0 and were dropped in 3.x. Any
      // other major reads false — the generic resolve path always works, so
      // "unknown" degrades safely here without needing a third value.
      userLookups: { byTelegramId: major === 2, byEmail: major === 2 },
    };
  }

  /**
   * Reads the panel version from `/api/system/stats/recap` (authoritative
   * `version` field on every tested build), falling back to the canonical
   * 2.8 source `/api/system/metadata`. Returns `null` when the panel is
   * unreachable or omits the field.
   */
  private async readVersion(): Promise<string | null> {
    try {
      const recap = await this.api.getSystemRecap();
      if (recap !== null && typeof recap.version === 'string' && recap.version.length > 0) {
        return recap.version;
      }
    } catch (err) {
      this.logger.debug(`recap version read failed: ${(err as Error).message}`);
    }
    try {
      const metadata = await this.api.getSystemMetadata();
      if (metadata !== null && typeof metadata.version === 'string' && metadata.version.length > 0) {
        return metadata.version;
      }
    } catch (err) {
      this.logger.debug(`metadata version read failed: ${(err as Error).message}`);
    }
    return null;
  }
}

/**
 * Picks the cache window for a detection result: anything that produced no
 * parsable version is a failure and gets the short negative TTL.
 */
function cacheTtlFor(value: RemnawaveCapabilities): number {
  return value.major === null ? CAPABILITIES_NEGATIVE_CACHE_TTL_MS : CAPABILITIES_CACHE_TTL_MS;
}

/** Only 2.x and 3.x path shapes are known; anything else stays unknown. */
function userAddressingFor(major: number): RemnawaveUserAddressing {
  if (major === 2) return 'uuid';
  if (major === 3) return 'id';
  return 'unknown';
}

/** Only 2.x and 3.x endpoint families are known; anything else stays unknown. */
function connectionsApiFor(major: number): RemnawaveConnectionsApi {
  if (major === 2) return 'ip-control';
  if (major === 3) return 'connections';
  return 'unknown';
}

/** Parses a `major.minor.patch` prefix from a version string. */
function parseSemver(
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
