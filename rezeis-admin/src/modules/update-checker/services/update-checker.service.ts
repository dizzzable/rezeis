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
 * latest release on a configurable GitHub repository.
 *
 * Configuration
 *   `REZEIS_UPDATE_REPO` — `<owner>/<repo>` slug (e.g. `rezeis/rezeis-admin`).
 *   When unset, the service reports `source: 'unknown'` with no error so
 *   self-hosted forks aren't bothered with phantom warnings.
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

  private cached: UpdateCheckResultInterface | null = null;
  private cachedAt = 0;

  public constructor(
    @Optional()
    private readonly httpService?: HttpService,
  ) {}

  public async onModuleInit(): Promise<void> {
    // Don't block startup — fire and forget. Failure logs but never
    // throws (see `safeCheck`).
    this.safeCheck().catch(() => undefined);
  }

  /**
   * Returns the current cached result, refreshing on demand if stale.
   * Used by the admin UI banner.
   */
  public async getStatus(forceRefresh = false): Promise<UpdateCheckResultInterface> {
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
    await this.safeCheck().catch(() => undefined);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async safeCheck(): Promise<UpdateCheckResultInterface> {
    const current = (PACKAGE_JSON.version ?? '0.0.0').trim();
    const checkedAt = new Date().toISOString();

    if (!DEFAULT_GITHUB_REPO || !this.httpService) {
      const result: UpdateCheckResultInterface = {
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
      this.cached = result;
      this.cachedAt = Date.now();
      return result;
    }

    try {
      const url = `https://api.github.com/repos/${DEFAULT_GITHUB_REPO}/releases/latest`;
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
        const result: UpdateCheckResultInterface = {
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
        this.cached = result;
        this.cachedAt = Date.now();
        return result;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`GitHub responded with HTTP ${response.status}`);
      }
      const release = response.data;
      if (release.draft || release.prerelease) {
        // Skip drafts and prereleases — operators don't want banners
        // about unstable builds.
        const result: UpdateCheckResultInterface = {
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
        this.cached = result;
        this.cachedAt = Date.now();
        return result;
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
      this.cached = result;
      this.cachedAt = Date.now();
      this.logger.log(
        `Update check: current=${current} latest=${latest || '(unknown)'} hasUpdate=${result.hasUpdate}`,
      );
      return result;
    } catch (err) {
      this.logger.warn(`Update check failed: ${(err as Error).message}`);
      // Fall back to whatever we cached before, but preserve the error
      // so the UI can show it.
      const fallback: UpdateCheckResultInterface = this.cached
        ? { ...this.cached, error: (err as Error).message, checkedAt }
        : {
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
      this.cached = fallback;
      this.cachedAt = Date.now();
      return fallback;
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
