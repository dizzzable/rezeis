const BOUNDED_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,96}$/;
const AUTHORIZATION_HEADER_PATTERN = /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?[-A-Za-z0-9._~+/=]+/giu;
const COOKIE_HEADER_PATTERN = /\b(?:cookie|set-cookie)\s*[:=]\s*(?:[^\s;]+(?:;\s*[^\s;]+)*)/giu;
const URL_ASSIGNMENT_PATTERN = /\b(?:callback|checkout|config|fail|payment|profile|redirect|return|success|subscription)[_-]?(?:link|uri|url)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const URL_PATTERN = /\b(?:https?|postgres|mysql|mongodb|redis|amqp):\/\/\S+/giu;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const PROVIDER_IDENTIFIER_PATTERN = /\b(?:acct|cus|evt|gw|in|pay|payment|pi|pm|price|prod|provider|re|rfnd|seti|si|sub|subscription|txn|wh)_[A-Za-z0-9][A-Za-z0-9_-]{3,}\b/giu;
const HEX_SECRET_PATTERN = /\b[0-9a-f]{24,}\b/giu;
const IDENTIFIER_ASSIGNMENT_PATTERN = /\b(?:customer|event|external|gateway|invoice|merchant|order|provider|transaction)[_-]?(?:id|ref|reference|uuid)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const TOKEN_ASSIGNMENT_PATTERN = /\b(?:access[_-]?token|api[_-]?key|auth(?:orization)?|bearer\w*|client[_-]?secret|credential|hmac|id[_-]?token|password|refresh[_-]?token|secret|signature|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const TOKEN_WORD_PATTERN = /(?<!\[)\b(?:api[_-]?key|auth(?:orization)?|bearer\w*|cookie|credential|password|secret|token)\b/giu;

export function normalizePaymentProviderError(
  value: unknown,
  fallback = 'PAYMENT_PROVIDER_ERROR',
): string {
  const raw = errorText(value);
  if (raw !== null && BOUNDED_ERROR_CODE_PATTERN.test(raw)) {
    return raw;
  }
  if (raw !== null && /(?:ETIMEDOUT|timeout|timed out)/iu.test(raw)) {
    return 'PAYMENT_PROVIDER_TIMEOUT';
  }
  if (raw !== null && /(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|unavailable)/iu.test(raw)) {
    return 'PAYMENT_PROVIDER_UNAVAILABLE';
  }
  return fallback;
}

export function redactPaymentDiagnosticMessage(
  value: string | null | undefined,
  maxLength = 300,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const redacted = value
    .replace(AUTHORIZATION_HEADER_PATTERN, '[token hidden]')
    .replace(COOKIE_HEADER_PATTERN, '[cookie hidden]')
    .replace(URL_ASSIGNMENT_PATTERN, '[url hidden]')
    .replace(URL_PATTERN, '[url hidden]')
    .replace(EMAIL_PATTERN, '[email hidden]')
    .replace(UUID_PATTERN, '[uuid hidden]')
    .replace(PROVIDER_IDENTIFIER_PATTERN, '[identifier hidden]')
    .replace(IDENTIFIER_ASSIGNMENT_PATTERN, '[identifier hidden]')
    .replace(TOKEN_ASSIGNMENT_PATTERN, '[token hidden]')
    .replace(TOKEN_WORD_PATTERN, '[token hidden]')
    .replace(HEX_SECRET_PATTERN, '[secret hidden]')
    .replace(/\s+/g, ' ')
    .trim();

  return redacted.length > 0 ? redacted.slice(0, maxLength) : null;
}

function errorText(value: unknown): string | null {
  if (value instanceof Error) {
    return value.message.trim() || null;
  }
  if (typeof value === 'string') {
    return value.trim() || null;
  }
  return null;
}
