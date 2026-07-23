import { registerAs } from '@nestjs/config';

/**
 * Advertising-cabinet deep-link configuration. rezeis does not own the bot
 * username / Mini-App URL at runtime (reiwa resolves those), so the operator
 * supplies them here purely to render copyable links in the admin cabinet. When
 * unset, the cabinet still shows the raw `ad_<code>` payload and tracking code;
 * only the ready-made links are omitted.
 */
export interface AdvertisingConfiguration {
  /** Public bot username for Reiwa (Telegram deep links `t.me/<bot>?start=...`). Used by cabinet and Reiwa. */
  readonly adminReiwaBotUsername: string | null;
  /** Mini-App short name for `t.me/<bot>/<shortName>?startapp=...` links. */
  readonly miniAppShortName: string | null;
  /** Web base URL for the Mini-App campaign form (`<base>/?campaign=...`). */
  readonly webBaseUrl: string | null;
}

function normalizeOptional(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function deriveWebBaseUrl(): string | null {
  const domain = normalizeOptional(process.env.REZEIS_DOMAIN);
  if (domain === null || domain === 'localhost') return null;
  const scheme = domain.includes('.') ? 'https' : 'http';
  return `${scheme}://${domain}`;
}

export const advertisingConfig = registerAs(
  'advertising',
  (): AdvertisingConfiguration => ({
    adminReiwaBotUsername: normalizeOptional(process.env.REIWA_BOT_USERNAME) ?? normalizeOptional(process.env.BOT_USERNAME)?.replace(/^@+/, '') ?? null,
    miniAppShortName: normalizeOptional(process.env.MINIAPP_SHORT_NAME),
    webBaseUrl: normalizeOptional(process.env.MINIAPP_CUSTOM_URL) ?? deriveWebBaseUrl(),
  }),
);
