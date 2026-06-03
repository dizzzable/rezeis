const SAFE_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const SENSITIVE_REQUEST_ID_PATTERN = /(?:auth|authorization|bearer|cookie|credential|password|secret|session|token)/iu;
const SENSITIVE_PATH_SEGMENT_PATTERNS = [
  /^\d+$/u,
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/u,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
  /^[0-9a-f]{24,}$/iu,
  /^(?:acct|cus|evt|gw|in|pay|pi|pm|price|prod|re|rfnd|seti|si|sub|txn|wh)_[A-Za-z0-9][A-Za-z0-9_-]{3,}$/iu,
];

export function isSafeRequestId(value: string | undefined | null): value is string {
  return (
    typeof value === 'string' &&
    SAFE_REQUEST_ID_PATTERN.test(value) &&
    !SENSITIVE_REQUEST_ID_PATTERN.test(value)
  );
}

export function sanitizePath(url: string): string {
  const withoutFragment = url.split('#', 1)[0] ?? '';
  const withoutQuery = withoutFragment.split('?', 1)[0] ?? '';
  const sanitized = withoutQuery
    .split('/')
    .map((segment) => (shouldRedactPathSegment(segment) ? ':redacted' : segment))
    .join('/');
  return sanitized.length > 256 ? sanitized.slice(0, 256) : sanitized;
}

function shouldRedactPathSegment(segment: string): boolean {
  if (segment.length === 0) {
    return false;
  }
  return SENSITIVE_PATH_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment));
}
