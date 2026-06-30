import { Injectable, Logger } from '@nestjs/common';

import { RemnawaveApiService } from './remnawave-api.service';

/**
 * Detected Remnawave panel version + the capability flags rezeis derives from
 * it. The integration targets a tested range (currently 2.7.x – 2.8.x); the
 * `supported` flag tells the admin SPA whether to show a "compatible" or an
 * "untested version" banner.
 *
 * Capabilities are version-gated so the rest of the app can light up
 * 2.8-only behaviour automatically once a panel upgrades, without a redeploy
 * or manual toggle:
 *   • `liveIpControl`        — ip-control matured enough to drive the Live tab.
 *   • `hostsTagsArray`       — hosts expose `tags[]` instead of a single `tag`.
 *   • `usersStream`          — `GET /api/users/stream`.
 *   • `hostsBulkUpdate`      — `PATCH /api/hosts/bulk/update`.
 *   • `tokenScopes`          — `GET /api/tokens/scopes`.
 *   • `bandwidthNodesUsers`  — `POST /api/bandwidth-stats/nodes/users`.
 */
export interface RemnawaveCapabilities {
  readonly version: string | null;
  readonly major: number | null;
  readonly minor: number | null;
  readonly patch: number | null;
  /** True when the detected version is inside the tested 2.7–2.8 range. */
  readonly supported: boolean;
  /** True when the panel responded at all (version could be read). */
  readonly reachable: boolean;
  readonly liveIpControl: boolean;
  readonly hostsTagsArray: boolean;
  readonly usersStream: boolean;
  readonly hostsBulkUpdate: boolean;
  readonly tokenScopes: boolean;
  readonly bandwidthNodesUsers: boolean;
}

/** Lowest panel version rezeis has been tested against. */
const MIN_TESTED = { major: 2, minor: 7 };
/** Highest panel minor rezeis has been tested against. */
const MAX_TESTED_MINOR = 8;

const CACHE_TTL_MS = 5 * 60_000;

@Injectable()
export class RemnawaveVersionService {
  private readonly logger = new Logger(RemnawaveVersionService.name);
  private cache: { value: RemnawaveCapabilities; at: number } | null = null;

  public constructor(private readonly api: RemnawaveApiService) {}

  /** Returns cached capabilities, refreshing past the TTL. */
  public async getCapabilities(force = false): Promise<RemnawaveCapabilities> {
    const now = Date.now();
    if (!force && this.cache !== null && now - this.cache.at < CACHE_TTL_MS) {
      return this.cache.value;
    }
    const value = await this.detect();
    this.cache = { value, at: now };
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
        hostsTagsArray: false,
        usersStream: false,
        hostsBulkUpdate: false,
        tokenScopes: false,
        bandwidthNodesUsers: false,
      };
    }
    const { major, minor, patch } = parsed;
    const atLeast = (mj: number, mn: number): boolean => major > mj || (major === mj && minor >= mn);
    const supported =
      major === MIN_TESTED.major && minor >= MIN_TESTED.minor && minor <= MAX_TESTED_MINOR;
    const is28Plus = atLeast(2, 8);
    return {
      version,
      major,
      minor,
      patch,
      supported,
      reachable: true,
      liveIpControl: is28Plus,
      hostsTagsArray: is28Plus,
      usersStream: is28Plus,
      hostsBulkUpdate: is28Plus,
      tokenScopes: is28Plus,
      bandwidthNodesUsers: is28Plus,
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
