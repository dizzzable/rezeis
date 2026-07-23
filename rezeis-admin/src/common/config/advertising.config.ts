import { registerAs } from '@nestjs/config';

/**
 * Advertising-cabinet deep-link configuration. Reiwa owns the public bot
 * username and web URL at runtime; this module only defines the Reiwa endpoint
 * and optional safe fallbacks. When neither Reiwa nor a fallback supplies a
 * value, the cabinet still shows the raw `ad_<code>` payload and tracking code;
 * only the ready-made links are omitted.
 */
export interface AdvertisingConfiguration {
  /** Optional static fallback for Reiwa's public bot username. */
  readonly adminReiwaBotUsername: string | null;
  /** Mini-App short name for `t.me/<bot>/<shortName>?startapp=...` links. */
  readonly miniAppShortName: string | null;
  /** Optional static fallback for the Reiwa web/Mini-App URL. */
  readonly webBaseUrl: string | null;
  /** Reiwa API base URL; Reiwa is the source of truth for public deep links. */
  readonly reiwaApiBaseUrl: string | null;
}

function normalizeOptional(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHttpUrl(value: string | undefined): string | null {
  const normalized = normalizeOptional(value);
  if (normalized === null) return null;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export const advertisingConfig = registerAs(
  'advertising',
  (): AdvertisingConfiguration => ({
    adminReiwaBotUsername: normalizeOptional(process.env.REIWA_BOT_USERNAME) ?? normalizeOptional(process.env.BOT_USERNAME)?.replace(/^@+/, '') ?? null,
    miniAppShortName: normalizeOptional(process.env.MINIAPP_SHORT_NAME),
    // Do not fall back to REZEIS_DOMAIN: it is the admin origin, while every
    // advertising deep link must target the user-facing Reiwa application.
    webBaseUrl: normalizeHttpUrl(process.env.REIWA_WEB_BASE_URL) ?? normalizeHttpUrl(process.env.MINIAPP_CUSTOM_URL),
    reiwaApiBaseUrl: normalizeHttpUrl(process.env.REIWA_URL) ?? 'http://reiwa:5000',
  }),
);
