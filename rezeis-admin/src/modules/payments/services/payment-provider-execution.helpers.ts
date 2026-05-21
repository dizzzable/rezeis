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

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

export function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

// ── URL builders ───────────────────────────────────────────────────────

/**
 * Resolves the URL the payment provider must redirect to on success.
 *
 * Order of precedence:
 *  1. Explicit `successUrl` provided by the caller (e.g. reiwa supplies
 *     a Telegram deep link for Mini App context, or a web origin for
 *     browser context).
 *  2. Default web fallback `${RUID_DOMAIN}/payments/result?paymentId=...`.
 */
export function resolveSuccessUrl(
  domain: string | null,
  paymentId: string,
  override?: string | null,
): string {
  const trimmed = override?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return buildResultUrl(domain, paymentId);
}

/**
 * Resolves the URL the payment provider must redirect to on failure /
 * cancellation. Falls back to the resolved success URL when no explicit
 * failure URL is given.
 */
export function resolveFailUrl(
  domain: string | null,
  paymentId: string,
  failOverride?: string | null,
  successOverride?: string | null,
): string {
  const trimmed = failOverride?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return resolveSuccessUrl(domain, paymentId, successOverride);
}

export function buildResultUrl(domain: string | null, paymentId: string): string {
  if (domain === null) {
    throw new ServiceUnavailableException('RUID public web URL is not configured');
  }
  const normalizedBaseUrl = domain.replace(/\/$/, '');
  return `${normalizedBaseUrl}/payments/result?paymentId=${encodeURIComponent(paymentId)}`;
}

export function buildWebhookUrl(domain: string | null, gatewayType: PaymentGatewayType): string {
  if (domain === null) {
    throw new ServiceUnavailableException('Admin public base URL is not configured');
  }
  const normalizedBaseUrl = domain.replace(/\/$/, '');
  return `${normalizedBaseUrl}/api/v1/payments/webhooks/${gatewayType}`;
}
