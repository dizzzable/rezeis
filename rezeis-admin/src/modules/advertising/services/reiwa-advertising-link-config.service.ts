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
 */
@Injectable()
export class ReiwaAdvertisingLinkConfigService {
  private readonly logger = new Logger(ReiwaAdvertisingLinkConfigService.name);
  private cached: AdvertisingDeepLinkConfiguration | null = null;
  private cacheUntil = 0;

  public constructor(
    @Inject(advertisingConfig.KEY)
    private readonly config: ConfigType<typeof advertisingConfig>,
  ) {}

  public async resolve(): Promise<AdvertisingDeepLinkConfiguration> {
    if (this.cached !== null && Date.now() < this.cacheUntil) {
      return this.cached;
    }

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
        return this.cache(fallback, FAILURE_CACHE_TTL_MS);
      }
      const payload = (await response.json()) as unknown;
      const remote = readReiwaDeepLinkConfiguration(payload);
      return this.cache(
        {
          adminReiwaBotUsername: remote.adminReiwaBotUsername ?? fallback.adminReiwaBotUsername,
          miniAppShortName: fallback.miniAppShortName,
          webBaseUrl: remote.webBaseUrl ?? fallback.webBaseUrl,
        },
        SUCCESS_CACHE_TTL_MS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Unable to load Reiwa public deep-link config: ${message}`);
      return this.cache(fallback, FAILURE_CACHE_TTL_MS);
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
