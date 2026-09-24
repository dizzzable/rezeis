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
// `RemnawaveApiService` reads the same version and cannot inject this service
// back without a cycle. Re-exported here so every existing importer keeps
// working.
export type {
  RemnawaveConnectionsApi,
  RemnawaveUserAddressing,
} from './panel-version.util';

/**
 * Direct user-lookup shortcuts (`/api/users/by-telegram-id/{id}`,
 * `/api/users/by-email/{email}`). Remnawave 2.x had them; 3.x deleted both, and
 * 3.x is the only version this build speaks, so both are always `false`. Kept
 * as a wire field because the admin SPA reads it; "false" means "the adapter
 * looks users up through `GET /api/users/stream`".
 */
export interface RemnawaveUserLookups {
  readonly byTelegramId: boolean;
  readonly byEmail: boolean;
}

/**
 * Detected Remnawave panel version + the capability facts rezeis derives from
 * it, for the admin SPA. Nothing on the server reads this record to shape a
 * request: every request goes out in the 3.x shape, and a 2.x panel is refused
 * outright.
 *   • `supported`            — the detected `major.minor` is in the tested set:
 *                              no banner.
 *   • `tooOld`               — the panel is 2.x. rezeis refuses every request
 *                              to it («Обновите панель до 3.x»), so the SPA says
 *                              "not supported" rather than "untested".
 *   • `liveIpControl`        — this build can read live connections from this
 *                              panel (`/api/connections/*`, 3.x). Drives the
 *                              Live tab. The historical name is a wire field.
 *   • `bandwidthNodesUsers`  — `POST /api/bandwidth-stats/nodes/users`.
 *   • `userAddressing`       — `'id'` on 3.x, `'unknown'` otherwise.
 *   • `connectionsApi`       — `'connections'` on 3.x, `'unknown'` otherwise.
 *   • `userLookups`          — always false; see {@link RemnawaveUserLookups}.
 */
export interface RemnawaveCapabilities {
  readonly version: string | null;
  readonly major: number | null;
  readonly minor: number | null;
  readonly patch: number | null;
  /** True when the detected `major.minor` is in the tested set (see below). */
  readonly supported: boolean;
  /**
   * True when the panel reported a major below 3 — the rule
   * `LegacyPanelRefusal` and the adapter's gate refuse on. A version that could
   * not be read is never too old.
   */
  readonly tooOld: boolean;
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
 * answered on their trailing slash; `/api/connections/drop` existed, which is
 * the 3.x live-connection family this adapter speaks.
 *
 * 2.7 AND 2.8 ARE GONE FROM THIS SET DELIBERATELY, and their absence is one
 * half of withdrawing 2.x support rather than an oversight. The other half —
 * refusing 2.x out loud instead of letting it drift into silent 400s — is in
 * place on every path: `LegacyPanelRefusal` in `panel-transport.ts` answers
 * every command of the users, devices and infra clients with
 * `REZEIS_PANEL_TOO_OLD`, and `remnawave-api.service.ts` refuses before each of
 * its own HTTP sends, once the version probe reports a major below 3. Only the
 * version reads themselves still reach such a panel. So a 2.x operator gets the
 * "not supported" banner (`tooOld`) and a refusal everywhere. If you are here
 * because a 2.x install broke, that is the intended outcome, not a regression
 * to undo.
 *
 * Being in this set means "the operator gets no banner", not "every screen is
 * equally capable". Every 3.x reports `liveIpControl: true`: it serves
 * `connections/*`, and the adapter speaks it.
 *
 * Membership is keyed on `major.minor`, so this set cannot tell 3.4.1 from
 * 3.4.10 and never has: both are the single `'3.4'` entry, and a patch-level
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
        // A version nobody could read is never refused — see `LegacyPanelRefusal`.
        tooOld: false,
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
      // The same rule `LegacyPanelRefusal` and the adapter's gate refuse on, so
      // the banner says "not supported" exactly when every request is refused.
      tooOld: major < 3,
      reachable: true,
      // "This build can read live connections from this panel" — which is the
      // question every consumer actually asks, despite the historical name.
      // `/api/connections/*` on 3.x, and nothing else: a 2.x panel is refused,
      // and a 4.x or calver build has an UNKNOWN connections family — claiming
      // we can read live data from a panel whose shape we cannot name is the
      // same guess this file refuses to make everywhere else.
      liveIpControl: major === 3,
      // `POST /api/bandwidth-stats/nodes/users`, present on every 3.x.
      bandwidthNodesUsers: major > 2,
      userAddressing: userAddressingFor(major),
      connectionsApi: connectionsApiFor(major),
      // Both shortcuts were dropped in 3.x; see `RemnawaveUserLookups`.
      userLookups: { byTelegramId: false, byEmail: false },
    };
  }

  /**
   * Reads the panel version from `/api/system/stats/recap` (authoritative
   * `version` field on every tested build), falling back to
   * `/api/system/metadata`. Returns `null` when the panel is unreachable or
   * omits the field. Both reads are the adapter's two version readers, the
   * only methods its 2.x refusal lets through — which is what lets this record
   * say `tooOld` at all.
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

