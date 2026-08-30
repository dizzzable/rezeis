import { Injectable, Logger } from '@nestjs/common';

import {
  CAPABILITIES_CACHE_TTL_MS,
  CAPABILITIES_NEGATIVE_CACHE_TTL_MS,
  connectionsApiFor,
  parseSemver,
  readPanelVersionFrom,
  userAddressingFor,
  type RemnawaveConnectionsApi,
  type RemnawaveUserAddressing,
} from './panel-version.util';
import { RemnawaveApiService } from './remnawave-api.service';

// The two shape unions and the version→shape derivation live in
// `panel-version.util.ts`, with no dependencies of their own, because
// `RemnawaveApiService` needs the same answer to build its paths and cannot
// inject this service back without a cycle. Re-exported here so every existing
// importer keeps working.
export type {
  RemnawaveConnectionsApi,
  RemnawaveUserAddressing,
} from './panel-version.util';

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
 *   • `liveIpControl`        — this build can read live connections from this
 *                              panel, whichever family serves them:
 *                              `/api/ip-control/*` once it matured (2.8+), or
 *                              `/api/connections/*` on 3.x. Drives the Live tab
 *                              and the IP-sharing detector.
 *   • `bandwidthNodesUsers`  — `POST /api/bandwidth-stats/nodes/users`.
 *   • `userAddressing`       — uuid- vs id-addressed user paths.
 *   • `connectionsApi`       — which live-connection family exists.
 *   • `userLookups`          — which by-telegram-id / by-email shortcuts exist.
 *
 * The three latter fields are NOT descriptive any more. This note used to say
 * "nothing consumes them yet, and adding them does not enable any 3.x
 * behaviour", which is false in the direction that makes a reader believe 3.x
 * is unwired:
 *   • `connectionsApi`  — `classifyLiveConnectionBlindness` (sharing-detectors)
 *                         reads it to decide whether a panel HAS live-connection
 *                         data at all, and the adapter picks `/api/connections/*`
 *                         over `/api/ip-control/*` from the same fact;
 *   • `userAddressing`  — drives `panelUserAddress`, i.e. how every user-scoped
 *                         route names a profile;
 *   • `userLookups`     — picks the by-telegram-id / by-email shortcut over the
 *                         generic resolve.
 * The adapter reads its own copy of these through `getPanelShape()`, so both
 * sides derive them from `panel-version.util` and cannot disagree; the SPA
 * reads them from this record. The one-place-to-read-the-panel-shape-from
 * intent stands, with an explicit "we do not know" state.
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
 * Every entry is measured against a live panel, and 3.4 earned its place the
 * same way the others did: a throwaway 3.4.1 stack, an API token, and the
 * calls this integration actually makes. `/api/system/stats/recap` and
 * `/api/system/metadata` both reported `3.4.1`; `/api/users/{numericId}`
 * answered; a missing user came back `A063`, which
 * `PANEL_USER_NOT_FOUND_ERROR_CODES` already carries; both squad routes
 * answered on their trailing slash; `/api/connections/drop` existed and
 * `/api/ip-control/*` was gone, which is the 3.x shape this adapter expects.
 *
 * 2.7 AND 2.8 ARE GONE FROM THIS SET DELIBERATELY, and their absence is the
 * first half of withdrawing 2.x support rather than an oversight. The branches
 * that still address a 2.x panel are alive as this is written, so a 2.x
 * operator currently gets the banner and a working panel; the second half —
 * refusing 2.x out loud instead of letting it drift into silent 400s — is a
 * separate change against the deletion path and has not been made yet. If you
 * are here because a 2.x install broke, that is the expected direction of
 * travel, not a regression to undo.
 *
 * Being in this set means "the operator gets no banner", not "every screen is
 * equally capable". 3.x reports `liveIpControl: true`: it replaced the
 * `ip-control/*` family with `connections/*`, and the adapter speaks it.
 *
 * Membership is keyed on `major.minor`, so this set cannot tell 3.4.1 from
 * 3.4.2 and never has: both are the single `'3.4'` entry, and a patch-level
 * difference is not something this gate is able to warn about. 3.3.2 is
 * therefore covered by `'3.3'`.
 *
 * Whatever this set says has to stay true of the operator-facing prose in
 * `web/src/i18n/features/remnawave.{en,ru}.ts` →
 * `remnaWavePage.versionWarning.description`, which spells the list out. That
 * is not left to good intentions any more: `test/remnawave-version.service.spec.ts`
 * discovers this set through `supported` and fails if either language's prose
 * names a different one.
 */
const TESTED_VERSIONS: ReadonlySet<string> = new Set(['3.2', '3.3', '3.4']);

// Both windows live in the util so the adapter's own shape cache uses the same
// two numbers rather than a second opinion about how long a panel blip lasts.
export {
  CAPABILITIES_CACHE_TTL_MS,
  CAPABILITIES_NEGATIVE_CACHE_TTL_MS,
} from './panel-version.util';

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
      // "This build can read live connections from this panel" — which is the
      // question every consumer actually asks, despite the historical name.
      //
      // It is NOT `connectionsApi !== 'unknown'`. That would light up on 2.7.4,
      // which serves `ip-control/*` but not maturely enough to drive the Live
      // tab or the IP-sharing detector. The two eras qualify for different
      // reasons and both have to be stated:
      //   2.x  — only 2.8 and newer, where `ip-control/*` matured;
      //   3.x  — `connections/*`, now that the adapter speaks it. Before that
      //          reader existed this had to stay false, or the detector would
      //          have walked every node for guaranteed 404s and reported a
      //          clean panel. The two changes were required to land together.
      // `major === 3`, not `major > 2`: a 4.x or calver build has an UNKNOWN
      // connections family, and claiming we can read live data from a panel
      // whose shape we cannot name is the same guess this file refuses to make
      // everywhere else.
      liveIpControl: major === 3 || (major === 2 && minor >= 8),
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
    // The order — recap, then metadata — is shared with the adapter's own shape
    // cache through `readPanelVersionFrom`, so the two cannot disagree about
    // which source wins on a build where only one of them carries the field.
    return readPanelVersionFrom(
      () => this.api.getSystemRecap(),
      () => this.api.getSystemMetadata(),
      (source, error) => this.logger.debug(`${source} version read failed: ${error.message}`),
    );
  }
}

/**
 * Picks the cache window for a detection result: anything that produced no
 * parsable version is a failure and gets the short negative TTL.
 */
function cacheTtlFor(value: RemnawaveCapabilities): number {
  return value.major === null ? CAPABILITIES_NEGATIVE_CACHE_TTL_MS : CAPABILITIES_CACHE_TTL_MS;
}

