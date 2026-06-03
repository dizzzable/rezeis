/**
 * Client error logger.
 *
 * Catches `window.error` and `unhandledrejection` events in the browser
 * and POSTs them to `/admin/client-errors` so the operator can see SPA
 * crashes alongside server-side audit events.
 *
 * The endpoint is best-effort: failures are swallowed silently — losing
 * a crash report is less bad than a crash loop caused by the reporter
 * itself.
 *
 * Rate limiting: at most one report per 30 s with the same fingerprint
 * (`message + filename + lineno + colno`) so a noisy bug doesn't flood
 * the backend.
 */
import { api } from './api';

type ClientLogSource = 'window.error' | 'unhandledrejection' | 'react.errorBoundary';

interface ClientLogPayload {
  readonly message: string;
  readonly stack?: string;
  readonly source: ClientLogSource;
  readonly url: string;
  readonly userAgent: string;
  readonly filename?: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly componentStack?: string;
  readonly capturedAt: string;
}

const RATE_LIMIT_WINDOW_MS = 30_000;
const REDACTED = '[redacted]';
const REDACTED_EMAIL = '[redacted-email]';
const REDACTED_QUERY = '[redacted-query]';
const REDACTED_UUID = '[redacted-uuid]';

const URL_WITH_QUERY_PATTERN = /\b((?:https?:\/\/|\/)[^\s'"<>?#]+)\?([^\s'"<>#)]*)/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const LONG_HEX_PATTERN = /\b[0-9a-f]{32,}\b/gi;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const COOKIE_HEADER_PATTERN = /\b(set-cookie|cookie)\s*[:=]\s*[^\r\n]+/gi;
const SENSITIVE_ASSIGNMENT_PATTERN = /(["']?\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|jwt|api[_-]?key|password|secret|session(?:id)?)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\])]+)/gi;

const recent = new Map<string, number>();

let installed = false;

function shouldReport(fingerprint: string): boolean {
  const now = Date.now();
  const last = recent.get(fingerprint);
  if (last !== undefined && now - last < RATE_LIMIT_WINDOW_MS) return false;
  recent.set(fingerprint, now);
  // Garbage-collect old entries
  if (recent.size > 64) {
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    for (const [key, ts] of recent.entries()) {
      if (ts < cutoff) recent.delete(key);
    }
  }
  return true;
}

export function redactClientLogValue(value: string): string {
  return value
    .replace(COOKIE_HEADER_PATTERN, (_match, key: string) => `${key}: ${REDACTED}`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(AUTH_SCHEME_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(URL_WITH_QUERY_PATTERN, (_match, prefix: string) => `${prefix}?${REDACTED_QUERY}`)
    .replace(JWT_PATTERN, REDACTED)
    .replace(EMAIL_PATTERN, REDACTED_EMAIL)
    .replace(UUID_PATTERN, REDACTED_UUID)
    .replace(LONG_HEX_PATTERN, REDACTED);
}

function safeConsoleValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactClientLogValue(value.message),
      stack: value.stack ? redactClientLogValue(value.stack) : undefined,
    };
  }
  if (typeof value === 'string') return redactClientLogValue(value);
  if (typeof value !== 'object' || value === null) return value;
  try {
    return redactClientLogValue(JSON.stringify(value));
  } catch {
    return '[unserializable]';
  }
}

export function logClientDiagnostic(label: string, ...details: unknown[]): void {
  if (!import.meta.env.DEV) return;
  console.error(redactClientLogValue(label), ...details.map(safeConsoleValue));
}

function redactedLocationHref(): string {
  return redactClientLogValue(window.location.href);
}

async function send(payload: ClientLogPayload): Promise<void> {
  try {
    await api.post('/admin/client-errors', payload, { timeout: 5000 });
  } catch {
    /* swallow — crash reporter must not amplify the failure */
  }
}

/**
 * Report a React render error caught by an ErrorBoundary.
 * Best-effort: never throws, never blocks the caller.
 */
export function reportReactError(error: Error, componentStack: string | null | undefined): void {
  if (typeof window === 'undefined') return;
  const message = redactClientLogValue(error.message);
  const stack = error.stack ? redactClientLogValue(error.stack) : undefined;
  const safeComponentStack = componentStack ? redactClientLogValue(componentStack) : undefined;
  // Fingerprint by error message + first frame of the component stack so
  // the same boundary doesn't spam the backend on every retry.
  const firstFrame = safeComponentStack?.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
  const fingerprint = `react|${message}|${firstFrame}`;
  if (!shouldReport(fingerprint)) return;
  void send({
    message,
    stack,
    source: 'react.errorBoundary',
    url: redactedLocationHref(),
    userAgent: redactClientLogValue(navigator.userAgent),
    componentStack: safeComponentStack,
    capturedAt: new Date().toISOString(),
  });
}

/** Install the global error / rejection handlers. Idempotent. */
export function installClientLogger(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (event: ErrorEvent) => {
    const message = redactClientLogValue(event.message);
    const filename = event.filename ? redactClientLogValue(event.filename) : undefined;
    const stack = event.error instanceof Error && event.error.stack
      ? redactClientLogValue(event.error.stack)
      : undefined;
    const fingerprint = `${message}|${filename ?? ''}|${event.lineno ?? 0}|${event.colno ?? 0}`;
    if (!shouldReport(fingerprint)) return;
    void send({
      message,
      stack,
      source: 'window.error',
      url: redactedLocationHref(),
      userAgent: redactClientLogValue(navigator.userAgent),
      filename,
      lineno: event.lineno,
      colno: event.colno,
      capturedAt: new Date().toISOString(),
    });
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message = redactClientLogValue(reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection'));
    const stack = reason instanceof Error && reason.stack ? redactClientLogValue(reason.stack) : undefined;
    const fingerprint = `rejection|${message}|${stack?.split('\n')[1] ?? ''}`;
    if (!shouldReport(fingerprint)) return;
    void send({
      message,
      stack,
      source: 'unhandledrejection',
      url: redactedLocationHref(),
      userAgent: redactClientLogValue(navigator.userAgent),
      capturedAt: new Date().toISOString(),
    });
  });

  installed = true;
}
