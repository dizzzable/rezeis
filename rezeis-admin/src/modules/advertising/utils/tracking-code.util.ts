import { randomBytes } from 'node:crypto';

/**
 * Tracking codes are carried in the Telegram deep-link `start` parameter as
 * `ad_<code>`. Telegram caps the `start`/`startapp` payload at 64 chars and
 * only allows `[A-Za-z0-9_-]`, so codes use a 3–32 char subset of that
 * alphabet, leaving ample room for the `ad_` prefix.
 */
export const AD_CODE_PREFIX = 'ad_';

/** Telegram's hard limit on a `start`/`startapp` payload. */
export const TELEGRAM_START_PAYLOAD_MAX = 64;

const TRACKING_CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;

/** Alphabet for minted codes — unambiguous, URL/Telegram-safe. */
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** True when `code` is a syntactically valid tracking code. */
export function isValidTrackingCode(code: string): boolean {
  return TRACKING_CODE_RE.test(code);
}

/**
 * Mints a random tracking code of `length` (default 10) chars from the safe
 * alphabet. Uses rejection sampling so the distribution is uniform.
 */
export function generateTrackingCode(length = 10): string {
  const safeLength = Math.min(Math.max(length, 3), 32);
  const out: string[] = [];
  while (out.length < safeLength) {
    const bytes = randomBytes(safeLength);
    for (let i = 0; i < bytes.length && out.length < safeLength; i += 1) {
      const idx = bytes[i];
      // Reject the tail that would bias the modulo (256 % 62 != 0).
      if (idx >= CODE_ALPHABET.length * Math.floor(256 / CODE_ALPHABET.length)) {
        continue;
      }
      out.push(CODE_ALPHABET[idx % CODE_ALPHABET.length]);
    }
  }
  return out.join('');
}

/** Builds the `ad_<code>` payload, throwing if it would exceed Telegram's cap. */
export function buildAdPayload(code: string): string {
  const payload = `${AD_CODE_PREFIX}${code}`;
  if (payload.length > TELEGRAM_START_PAYLOAD_MAX) {
    throw new Error(`Advertising payload exceeds ${TELEGRAM_START_PAYLOAD_MAX} chars`);
  }
  return payload;
}

/**
 * Extracts the tracking code from a raw `start`/`startapp` payload. Returns
 * `null` when the payload is not an advertising payload or the embedded code is
 * malformed — so callers can fall through to the referral/link routing.
 */
export function parseAdPayload(payload: string | null | undefined): string | null {
  if (typeof payload !== 'string') {
    return null;
  }
  const trimmed = payload.trim();
  if (!trimmed.startsWith(AD_CODE_PREFIX)) {
    // UTM params may be appended; extract code from first segment.
    const firstSegment = trimmed.split(/[&?]/)[0]!;
    if (!firstSegment.startsWith(AD_CODE_PREFIX)) {
      return null;
    }
    const code = firstSegment.slice(AD_CODE_PREFIX.length);
    return isValidTrackingCode(code) ? code : null;
  }
  const code = trimmed.slice(AD_CODE_PREFIX.length);
  return isValidTrackingCode(code) ? code : null;
}

/** Extracts utm parameters from a deep-link payload (e.g. ?start=ad_xxx&utm_source=... ). */
export function parseAdUtm(payload: string): Record<string, string> {
  const utm: Record<string, string> = {};
  if (!payload.includes('utm_')) return utm;
  const search = payload.includes('?') ? payload.slice(payload.indexOf('?') + 1) : payload;
  const pairs = search.split(/[&?]/);
  for (const pair of pairs) {
    if (pair.includes('=')) {
      const [key, value] = pair.split('=');
      if (key.startsWith('utm_')) utm[key] = value;
    }
  }
  return utm;
}

/** Ready-to-share links for a placement's tracking code. All Telegram links use adminReiwaBotUsername for Reiwa compatibility. */
export interface AdDeepLinks {
  readonly botStart: string | null;
  readonly miniAppStart: string | null;
  readonly miniAppWeb: string | null;
}

/**
 * Builds the deep links operators paste into ads. Uses `adminReiwaBotUsername` for Reiwa Telegram compatibility.
 * the Mini-App links are emitted only when a Mini-App short-name / web base is
 * configured.
 */
export function buildAdDeepLinks(input: {
  readonly adminReiwaBotUsername?: string | null;
  readonly miniAppShortName?: string | null;
  readonly miniAppWebBaseUrl?: string | null;
  readonly code: string;
  readonly utmSource?: string;
  readonly utmCampaign?: string;
  readonly utmMedium?: string;
  readonly utmContent?: string;
  readonly utmCreative?: string;
}): AdDeepLinks {
  const payload = buildAdPayload(input.code);
  const bot = (input.adminReiwaBotUsername ?? '').replace(/^@+/, '').trim();
  const botStart = bot.length > 0 ? `https://t.me/${bot}?start=${payload}` : null;
  const shortName = (input.miniAppShortName ?? '').trim();
  const miniAppStart =
    bot.length > 0 && shortName.length > 0 ? `https://t.me/${bot}/${shortName}?startapp=${payload}` : null;
  const webBase = (input.miniAppWebBaseUrl ?? '').replace(/\/+$/, '').trim();
  const webParams = new URLSearchParams({ campaign: payload });
  if (input.utmSource) webParams.set('utm_source', input.utmSource);
  if (input.utmCampaign) webParams.set('utm_campaign', input.utmCampaign);
  if (input.utmMedium) webParams.set('utm_medium', input.utmMedium);
  if (input.utmContent) webParams.set('utm_content', input.utmContent);
  if (input.utmCreative) webParams.set('utm_creative', input.utmCreative);
  const miniAppWeb = webBase.length > 0 ? `${webBase}/?${webParams.toString()}` : null;
  return { botStart, miniAppStart, miniAppWeb };
}
