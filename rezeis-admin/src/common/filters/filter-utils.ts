const SAFE_REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export function isSafeRequestId(value: string | undefined | null): value is string {
  return typeof value === 'string' && SAFE_REQUEST_ID_PATTERN.test(value);
}

export function sanitizePath(url: string): string {
  // Remove query string and fragment
  const qIdx = url.indexOf('?');
  const path = qIdx >= 0 ? url.slice(0, qIdx) : url;
  // Limit length
  return path.length > 256 ? path.slice(0, 256) : path;
}
