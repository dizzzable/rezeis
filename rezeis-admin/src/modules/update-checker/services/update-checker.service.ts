import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';

import { shouldRunSchedules } from '../../../common/runtime/process-role.util';

// CommonJS interop: Node 24 still loads JSON modules via `require()` more
// reliably than via `import attributes`, and `package.json` lives outside
// the TS source root so an `import` would require additional tsconfig
// gymnastics. The explicit disable is intentional.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PACKAGE_JSON: { readonly version?: string } = require('../../../../package.json');

const DEFAULT_GITHUB_REPO = process.env.REZEIS_UPDATE_REPO ?? '';
const REIWA_GITHUB_REPO = process.env.REZEIS_REIWA_UPDATE_REPO ?? '';
/** Public base URL of reiwa — used to pull its live version from /health when
 *  no heartbeat has been reported yet (e.g. right after an admin restart).
 *  Defaults to the same-VPS docker service name; the zod schema default isn't
 *  reflected in `process.env`, so the fallback is applied here at the read
 *  site. Split-VPS deploys set `REIWA_URL=https://<reiwa-domain>` in `.env`. */
const REIWA_BASE_URL = (process.env.REIWA_URL ?? 'http://reiwa:5000').trim().replace(/\/+$/, '');
const HTTP_TIMEOUT_MS = 8_000;
const USER_AGENT = 'rezeis-admin-update-checker';

export interface UpdateCheckResultInterface {
  readonly current: string;
  readonly latest: string | null;
  readonly hasUpdate: boolean;
  readonly publishedAt: string | null;
  readonly htmlUrl: string | null;
  readonly notes: string | null;
  readonly checkedAt: string;
  readonly source: 'github' | 'unknown';
  readonly error: string | null;
}

/**
 * Combined update status for every component the panel tracks: the admin
 * panel itself plus the reiwa user cabinet (whose running version is
 * reported in by reiwa over the internal channel). The legacy banner /
 * indicator keep consuming the flat panel fields, so the panel result is
 * spread at the top level for backwards compatibility while `components`
 * carries the per-service breakdown.
 */
export interface UpdateStatusInterface extends UpdateCheckResultInterface {
  readonly components: {
    readonly panel: UpdateCheckResultInterface;
    readonly reiwa: UpdateCheckResultInterface;
  };
}

interface GithubReleaseResponse {
  readonly tag_name?: string;
  readonly name?: string;
  readonly published_at?: string;
  readonly html_url?: string;
  readonly body?: string;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
}

const RESULT_CACHE_MS = 60 * 60 * 1_000; // 1 hour

/**
 * Update checker — compares the local `package.json` version against the
 * latest release on a configurable GitHub repository, and does the same for
 * the reiwa user cabinet whose running version reiwa reports over the
 * internal channel.
 *
 * Configuration
 *   `REZEIS_UPDATE_REPO`       — panel `<owner>/<repo>` slug.
 *   `REZEIS_REIWA_UPDATE_REPO` — reiwa `<owner>/<repo>` slug.
 *   When a slug is unset, that component reports `source: 'unknown'` with no
 *   error so self-hosted forks aren't bothered with phantom warnings.
 *
 * Cache
 *   The latest result is cached for 1 hour. The hourly cron tops it up
 *   in the background; UI calls always hit the cache.
 *
 * Privacy
 *   The GitHub `releases/latest` endpoint is unauthenticated and the
 *   request body is empty — we don't transmit any panel data.
 */
@Injectable()
export class UpdateCheckerService implements OnModuleInit {
  private readonly logger = new Logger(UpdateCheckerService.name);

  private cached: UpdateStatusInterface | null = null;
  private cachedAt = 0;

  /**
   * Running reiwa version, reported in by reiwa over the internal channel
   * (`POST /api/internal/system/reiwa-version`). `null` until the first
   * heartbeat arrives — the check then falls back to `0.0.0` so an
   * unreported reiwa never produces a false "update available".
   */
  private reiwaReportedVersion: string | null = null;

  public constructor(
    @Optional()
    private readonly httpService?: HttpService,
  ) {}

  public async onModuleInit(): Promise<void> {
    // Don't block startup — fire and forget. Failure logs but never
    // throws (see `safeCheck`).
    this.safeCheck().catch((): void => undefined);
  }

  /**
   * Records the reiwa version reported by reiwa's heartbeat. Refreshes the
   * cached reiwa check so the next UI poll reflects the live version
   * without waiting for the hourly cron.
   */
  public reportReiwaVersion(version: string): void {
    const normalized = version.trim().replace(/^v/i, '');
    if (!normalized || normalized === this.reiwaReportedVersion) return;
    this.reiwaReportedVersion = normalized;
    this.logger.log(`reiwa reported version: ${normalized}`);
    // Recompute in the background so the cached payload picks up the new
    // current version (and recomputes hasUpdate) promptly.
    this.safeCheck().catch((): void => undefined);
  }

  /**
   * Returns the current cached result, refreshing on demand if stale.
   * Used by the admin UI banner.
   */
  public async getStatus(forceRefresh = false): Promise<UpdateStatusInterface> {
    if (!forceRefresh && this.cached && Date.now() - this.cachedAt < RESULT_CACHE_MS) {
      return this.cached;
    }
    return this.safeCheck();
  }

  /**
   * Hourly background refresh so the UI banner stays current without
   * an operator visiting the page.
   */
  @Cron(CronExpression.EVERY_HOUR)
  public async hourlyRefresh(): Promise<void> {
    if (!shouldRunSchedules()) return;
    await this.safeCheck().catch((): void => undefined);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Re-checks every tracked component and rebuilds the cached payload. The
   * panel result is spread at the top level so the legacy banner/indicator
   * (which read the flat fields) keep working unchanged.
   */
  private async safeCheck(): Promise<UpdateStatusInterface> {
    const panelCurrent = (PACKAGE_JSON.version ?? '0.0.0').trim();
    // Prefer the heartbeat-reported version (fast, no network). When it
    // hasn't arrived yet — typically right after an admin restart, since the
    // report is in-memory and reiwa only re-announces hourly — pull the live
    // version from reiwa's /health so the widget doesn't show a stale 0.0.0.
    const reiwaCurrent =
      this.reiwaReportedVersion ?? (await this.fetchReiwaVersionFromHealth()) ?? '0.0.0';

    const [panel, reiwa] = await Promise.all([
      this.checkRepo(DEFAULT_GITHUB_REPO, panelCurrent),
      this.checkRepo(REIWA_GITHUB_REPO, reiwaCurrent),
    ]);

    const result: UpdateStatusInterface = {
      ...panel,
      components: { panel, reiwa },
    };
    this.cached = result;
    this.cachedAt = Date.now();
    return result;
  }

  /**
   * Pulls reiwa's running version from its public `/api/v1/health` endpoint.
   * Best-effort fallback for when no heartbeat has been reported yet (the
   * reported value is in-memory and lost on admin restart). Returns `null`
   * when `REIWA_URL` is unset or reiwa is unreachable.
   */
  private async fetchReiwaVersionFromHealth(): Promise<string | null> {
    if (!REIWA_BASE_URL || !this.httpService) return null;
    try {
      const response = await firstValueFrom(
        this.httpService.get<{ version?: string }>(`${REIWA_BASE_URL}/api/v1/health`, {
          headers: { 'User-Agent': USER_AGENT },
          timeout: HTTP_TIMEOUT_MS,
          validateStatus: () => true,
        }),
      );
      if (response.status < 200 || response.status >= 300) return null;
      const version = response.data?.version?.trim().replace(/^v/i, '');
      return version && version.length > 0 ? version : null;
    } catch {
      return null;
    }
  }

  /**
   * Checks a single `<owner>/<repo>` against its current version. Never
   * throws — network/parse failures resolve to a result carrying the error
   * string so the UI can surface it. When `repo` is empty the component is
   * reported as `source: 'unknown'` (feature disabled for that component).
   */
  private async checkRepo(repo: string, current: string): Promise<UpdateCheckResultInterface> {
    const checkedAt = new Date().toISOString();

    if (!repo || !this.httpService) {
      return {
        current,
        latest: null,
        hasUpdate: false,
        publishedAt: null,
        htmlUrl: null,
        notes: null,
        checkedAt,
        source: 'unknown',
        error: null,
      };
    }

    try {
      const url = `https://api.github.com/repos/${repo}/releases/latest`;
      const response = await firstValueFrom(
        this.httpService.get<GithubReleaseResponse>(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': USER_AGENT,
          },
          timeout: HTTP_TIMEOUT_MS,
          validateStatus: () => true,
        }),
      );
      if (response.status === 404) {
        return {
          current,
          latest: null,
          hasUpdate: false,
          publishedAt: null,
          htmlUrl: null,
          notes: null,
          checkedAt,
          source: 'github',
          error: 'No releases published yet',
        };
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`GitHub responded with HTTP ${response.status}`);
      }
      const release = response.data;
      if (release.draft || release.prerelease) {
        return {
          current,
          latest: null,
          hasUpdate: false,
          publishedAt: null,
          htmlUrl: null,
          notes: null,
          checkedAt,
          source: 'github',
          error: 'No stable release found',
        };
      }
      const latest = (release.tag_name ?? '').replace(/^v/i, '').trim();
      const result: UpdateCheckResultInterface = {
        current,
        latest: latest || null,
        hasUpdate: latest ? compareSemver(current, latest) < 0 : false,
        publishedAt: release.published_at ?? null,
        htmlUrl: release.html_url ?? null,
        notes: truncate(release.body ?? '', 2_000),
        checkedAt,
        source: 'github',
        error: null,
      };
      this.logger.log(
        `Update check ${repo}: current=${current} latest=${latest || '(unknown)'} hasUpdate=${result.hasUpdate}`,
      );
      return result;
    } catch (err) {
      this.logger.warn(`Update check ${repo} failed: ${(err as Error).message}`);
      return {
        current,
        latest: null,
        hasUpdate: false,
        publishedAt: null,
        htmlUrl: null,
        notes: null,
        checkedAt,
        source: 'github',
        error: (err as Error).message,
      };
    }
  }
}

/**
 * Compares two semver-ish strings. Returns:
 *   negative when `a < b`
 *   zero      when `a === b`
 *   positive  when `a > b`
 *
 * Handles a subset: `MAJOR.MINOR.PATCH[-PRERELEASE]`. Pre-release tags
 * are compared lexicographically as a tiebreaker, mirroring the npm
 * convention "any prerelease < release of the same triple".
 */
export function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (parsedA.major !== parsedB.major) return parsedA.major - parsedB.major;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor - parsedB.minor;
  if (parsedA.patch !== parsedB.patch) return parsedA.patch - parsedB.patch;
  if (parsedA.pre === '' && parsedB.pre !== '') return 1;
  if (parsedA.pre !== '' && parsedB.pre === '') return -1;
  return parsedA.pre.localeCompare(parsedB.pre);
}

function parseSemver(value: string): { major: number; minor: number; patch: number; pre: string } {
  const trimmed = value.trim().replace(/^v/i, '');
  const [main, pre = ''] = trimmed.split('-', 2);
  const [maj, min, pat] = (main ?? '').split('.');
  return {
    major: toInt(maj),
    minor: toInt(min),
    patch: toInt(pat),
    pre,
  };
}

function toInt(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}
