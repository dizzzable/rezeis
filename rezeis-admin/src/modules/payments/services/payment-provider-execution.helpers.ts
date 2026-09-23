import { createHash } from 'node:crypto';

import { ServiceUnavailableException } from '@nestjs/common';
import { PaymentGatewayType } from '@prisma/client';

/**
 * Reads a JSON-ish blob into a `Record<string, unknown>`. Accepts plain
 * objects only — arrays and null collapse to `{}` so downstream
 * `readOptionalString` calls stay type-safe.
 */
export function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Returns the first non-empty string value among the listed keys.
 *
 * Numbers are coerced to their decimal representation so configuration
 * payloads from third-party admin UIs (which sometimes emit numeric
 * shop ids) parse cleanly.
 */
export function readOptionalString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return null;
}

/**
 * Read a setting and throw a 503 with a clear hint when missing. Used by
 * the gateway-specific helpers for required credentials/secrets — the
 * request fails fast with an operator-actionable message rather than
 * silently producing a wrong external request.
 */
export function requireSetting(
  settings: Record<string, unknown>,
  key: string,
): string {
  const value = readOptionalString(settings, [key]);
  if (value === null) {
    throw new ServiceUnavailableException(`Payment gateway setting ${key} is missing`);
  }
  return value;
}

/**
 * YooKassa shops may store the secret under either `apiKey` (panel form) or
 * `secretKey` (YooKassa docs / older configs). Accept both so a misnamed
 * setting does not take the whole gateway offline.
 */
export function requireYookassaSecretKey(settings: Record<string, unknown>): string {
  const value = readOptionalString(settings, ['apiKey', 'secretKey']);
  if (value === null) {
    throw new ServiceUnavailableException(
      'Payment gateway setting apiKey/secretKey is missing',
    );
  }
  return value;
}

/**
 * Reads a boolean-ish gateway setting. Accepts real booleans and the string
 * forms admin forms sometimes post (`"true"` / `"false"`). Missing values
 * fall back to `defaultValue`.
 */
export function readBooleanSetting(
  settings: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
): boolean {
  const raw = settings[key];
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw !== 0;
  }
  return defaultValue;
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

export function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

/** MulenPay signs requests with SHA-1 over a concatenation of four values. */
export function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

// ── URL builders ───────────────────────────────────────────────────────

/**
 * The site a payer-facing address is built on when the caller named none: the
 * operator's cabinet when its address is known, otherwise — exactly as before
 * the cabinet was used — the panel's own domain (`REZEIS_DOMAIN`). The panel is
 * the worse answer (the payer is shown the admin panel's address), never a
 * reason to refuse a payment.
 */
export type PayerFacingSite =
  | { readonly kind: 'CABINET'; readonly baseUrl: string }
  | { readonly kind: 'PANEL'; readonly domain: string | null };

/**
 * The page the caller named for the provider to send the payer back to (reiwa
 * supplies a Telegram deep link in the Mini App, its own web origin in a
 * browser), or `null` when it named none and {@link buildResultUrl} decides.
 */
export function explicitUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

/**
 * The page a payer returns to from the provider when the caller named none.
 *
 * On the cabinet: its `/payment-return`, which polls the payment and keeps its
 * link. Without the cabinet's address: `${REZEIS_DOMAIN}/payments/result`, the
 * panel's address this always was — unchanged, including its 503 when even
 * the panel's domain is missing.
 */
export function buildResultUrl(site: PayerFacingSite, paymentId: string): string {
  if (site.kind === 'CABINET') {
    return `${site.baseUrl.replace(/\/+$/, '')}/payment-return?paymentId=${encodeURIComponent(paymentId)}`;
  }
  if (site.domain === null) {
    throw new ServiceUnavailableException('RUID public web URL is not configured');
  }
  const normalizedBaseUrl = site.domain.replace(/\/$/, '');
  return `${normalizedBaseUrl}/payments/result?paymentId=${encodeURIComponent(paymentId)}`;
}

/**
 * The bare host a per-payment buyer address goes under: the cabinet's, or
 * without it the panel's, stripped exactly as before (scheme, path and port
 * off), with the same 503 when there is none at all.
 */
export function payerMailHost(site: PayerFacingSite): string {
  const host =
    site.kind === 'CABINET'
      ? new URL(site.baseUrl).hostname.toLowerCase()
      : site.domain === null
        ? ''
        : site.domain.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].split(':')[0].trim().toLowerCase();
  if (host.length === 0) {
    throw new ServiceUnavailableException('Admin public base URL is not configured');
  }
  return host;
}

export function buildWebhookUrl(domain: string | null, gatewayType: PaymentGatewayType): string {
  if (domain === null) {
    throw new ServiceUnavailableException('Admin public base URL is not configured');
  }
  const normalizedBaseUrl = domain.replace(/\/$/, '');
  return `${normalizedBaseUrl}/api/v1/payments/webhooks/${gatewayType}`;
}
