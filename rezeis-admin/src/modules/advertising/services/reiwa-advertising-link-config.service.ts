import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';

import { advertisingConfig, AdvertisingConfiguration } from '../../../common/config/advertising.config';

export type AdvertisingDeepLinkConfiguration = Pick<
  AdvertisingConfiguration,
  'adminReiwaBotUsername' | 'miniAppShortName' | 'webBaseUrl'
>;

const SUCCESS_CACHE_TTL_MS = 60_000;
const FAILURE_CACHE_TTL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 2_500;
const TELEGRAM_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

/**
 * Resolves the user-facing advertising targets from Reiwa's public config.
 * The admin domain is deliberately never used as a substitute: a stale or
 * unavailable Reiwa response hides ready-made links instead of issuing links
 * that lead users to the admin panel.
 *
 * It is also THE resolver of the cabinet's address for everything else that
 * sends a customer there — a letter's footer link, the guest reply's
 * «Открыть переписку», the logo a letter loads, a payer's return page — so a
 * letter and an ad cannot disagree. Provided once, by `ReiwaPublicLinksModule`,
 * with one cache.
 *
 * ── Under load, and when the cabinet does not answer ──────────────────────
 *
 * One request at a time: concurrent callers on a cold or expired cache share
 * the request in flight instead of each waiting up to 2.5 s for their own —
 * a broadcast's letters and a burst of checkouts arrive together. A failed
 * request is remembered for {@link FAILURE_CACHE_TTL_MS}, so the callers after
 * it do not wait again, and it keeps the address the cabinet LAST published
 * rather than falling back to .env: on a default install the fallback is no
 * address at all, and a payer sent there lands on the panel's 404.
 */
@Injectable()
export class ReiwaAdvertisingLinkConfigService {
  private readonly logger = new Logger(ReiwaAdvertisingLinkConfigService.name);
  private cached: AdvertisingDeepLinkConfiguration | null = null;
  private cacheUntil = 0;
  /** The request in flight, which every concurrent caller awaits. */
  private inFlight: Promise<AdvertisingDeepLinkConfiguration> | null = null;
  /** What the last SUCCESSFUL request resolved to — kept through failures. */
  private lastPublished: AdvertisingDeepLinkConfiguration | null = null;

  public constructor(
    @Inject(advertisingConfig.KEY)
    private readonly config: ConfigType<typeof advertisingConfig>,
  ) {}

  /**
   * The cabinet's public address: what the cabinet publishes
   * (`/api/v1/public-config` → `webBaseUrl`, from its own REIWA_DOMAIN) first,
   * then `REIWA_WEB_BASE_URL` → `MINIAPP_CUSTOM_URL`; `null` when neither
   * knows. Never the panel's domain.
   */
  public async resolveCabinetWebBaseUrl(): Promise<string | null> {
    return (await this.resolve()).webBaseUrl;
  }

  public async resolve(): Promise<AdvertisingDeepLinkConfiguration> {
    if (this.cached !== null && Date.now() < this.cacheUntil) {
      return this.cached;
    }
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    const request = this.askTheCabinet();
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = null;
    }
  }

  /** One request to the cabinet; never rejects. */
  private async askTheCabinet(): Promise<AdvertisingDeepLinkConfiguration> {
    const fallback = this.staticFallback();
    const baseUrl = this.config.reiwaApiBaseUrl;
    if (baseUrl === null) {
      return this.cache(fallback, FAILURE_CACHE_TTL_MS);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/api/v1/public-config`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(`Reiwa public config returned HTTP ${response.status}`);
        return this.cache(this.lastPublished ?? fallback, FAILURE_CACHE_TTL_MS);
      }
      const payload = (await response.json()) as unknown;
      const remote = readReiwaDeepLinkConfiguration(payload);
      const resolved: AdvertisingDeepLinkConfiguration = {
        adminReiwaBotUsername: remote.adminReiwaBotUsername ?? fallback.adminReiwaBotUsername,
        miniAppShortName: fallback.miniAppShortName,
        webBaseUrl: remote.webBaseUrl ?? fallback.webBaseUrl,
      };
      this.lastPublished = resolved;
      return this.cache(resolved, SUCCESS_CACHE_TTL_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Unable to load Reiwa public deep-link config: ${message}`);
      // Stale-if-error: the address the cabinet last published beats .env.
      return this.cache(this.lastPublished ?? fallback, FAILURE_CACHE_TTL_MS);
    } finally {
      clearTimeout(timeout);
    }
  }

  private staticFallback(): AdvertisingDeepLinkConfiguration {
    return {
      adminReiwaBotUsername: this.config.adminReiwaBotUsername,
      miniAppShortName: this.config.miniAppShortName,
      webBaseUrl: this.config.webBaseUrl,
    };
  }

  private cache(
    value: AdvertisingDeepLinkConfiguration,
    ttlMs: number,
  ): AdvertisingDeepLinkConfiguration {
    this.cached = value;
    this.cacheUntil = Date.now() + ttlMs;
    return value;
  }
}

function readReiwaDeepLinkConfiguration(value: unknown): Pick<
  AdvertisingDeepLinkConfiguration,
  'adminReiwaBotUsername' | 'webBaseUrl'
> {
  if (value === null || typeof value !== 'object') {
    return { adminReiwaBotUsername: null, webBaseUrl: null };
  }
  const payload = value as Record<string, unknown>;
  return {
    adminReiwaBotUsername: normalizeBotUsername(payload['botUsername']),
    webBaseUrl: normalizePublicUrl(payload['webBaseUrl']),
  };
}

function normalizeBotUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const username = value.trim().replace(/^@+/, '');
  return TELEGRAM_USERNAME_RE.test(username) ? username : null;
}

function normalizePublicUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}
