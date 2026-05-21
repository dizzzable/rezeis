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

interface ClientLogPayload {
  readonly message: string;
  readonly stack?: string;
  readonly source: 'window.error' | 'unhandledrejection';
  readonly url: string;
  readonly userAgent: string;
  readonly filename?: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly capturedAt: string;
}

const RATE_LIMIT_WINDOW_MS = 30_000;
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

async function send(payload: ClientLogPayload): Promise<void> {
  try {
    await api.post('/admin/client-errors', payload, { timeout: 5000 });
  } catch {
    /* swallow — crash reporter must not amplify the failure */
  }
}

/** Install the global error / rejection handlers. Idempotent. */
export function installClientLogger(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (event: ErrorEvent) => {
    const fingerprint = `${event.message}|${event.filename ?? ''}|${event.lineno ?? 0}|${event.colno ?? 0}`;
    if (!shouldReport(fingerprint)) return;
    void send({
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      source: 'window.error',
      url: window.location.href,
      userAgent: navigator.userAgent,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      capturedAt: new Date().toISOString(),
    });
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection');
    const stack = reason instanceof Error ? reason.stack : undefined;
    const fingerprint = `rejection|${message}|${stack?.split('\n')[1] ?? ''}`;
    if (!shouldReport(fingerprint)) return;
    void send({
      message,
      stack,
      source: 'unhandledrejection',
      url: window.location.href,
      userAgent: navigator.userAgent,
      capturedAt: new Date().toISOString(),
    });
  });

  installed = true;
}
