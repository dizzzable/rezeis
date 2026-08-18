import { Injectable, NestMiddleware, RequestTimeoutException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Global request timeout middleware.
 *
 * Aborts requests that exceed the configured timeout (default 30s).
 * Exceptions:
 *   - SSE streams (/internal/user/.../stream) - infinite timeout
 *   - File uploads (/admin/imports/..., /admin/broadcast/upload-media,
 *     /admin/faq/uploads) - 120s
 *   - Backup download (/admin/backup/download/...) - 120s
 *
 * This prevents slow/hung requests from consuming worker threads
 * indefinitely and protects against slowloris-style attacks.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

const LONG_TIMEOUT_PATTERNS = [
  /\/admin\/imports\//,
  /\/admin\/broadcast\/upload-media/,
  /\/admin\/faq\/uploads(?:[/?]|$)/,
  /\/admin\/backup\/download\//,
  // Both restore routes, and the reason the shapes differ: `restore/:filename`
  // ends in a slash, `restore-upload` ends at the path end. The pattern used to
  // be `restore\/` alone, so POST /admin/backup/restore-upload fell through to
  // the 30s default -- while the edge proxies advertise `client_max_body_size
  // 2g` for that exact path. A restore large enough to need the raised ceiling
  // was killed by the app three seconds into the minute it needed.
  /\/admin\/backup\/restore(?:-upload)?(?:[/?]|$)/,
];

// `:userRef` on the SSE stream is EITHER a numeric telegramId OR a CUID
// reiwa_id — the cabinet prefers the WebSession reiwa_id (see reiwa's
// `resolveUserIdentity`), so most real streams carry a CUID. A `\d+` class
// here would let those fall through to the 30s default instead of the
// no-timeout branch.
const INFINITE_TIMEOUT_PATTERNS = [/\/internal\/user\/[^/]+\/stream(?:[/?]|$)/, /\/realtime/];

@Injectable()
export class RequestTimeoutMiddleware implements NestMiddleware {
  public use(req: Request, res: Response, next: NextFunction): void {
    const path = req.originalUrl ?? req.url;
    const timeout = resolveRequestTimeoutMs(path);

    // SSE/WebSocket streams — no timeout
    if (timeout === null) {
      next();
      return;
    }

    // File uploads / downloads — extended timeout
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        const error = new RequestTimeoutException(`Request timed out after ${timeout}ms`);
        res.status(408).json({
          statusCode: 408,
          message: error.message,
          error: 'Request Timeout',
        });
      }
    }, timeout);

    // Clear timeout when response finishes
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    next();
  }
}

/** Resolve timeout policy independently so special routes are regression-testable. */
export function resolveRequestTimeoutMs(path: string): number | null {
  if (INFINITE_TIMEOUT_PATTERNS.some((pattern) => pattern.test(path))) return null;
  if (LONG_TIMEOUT_PATTERNS.some((pattern) => pattern.test(path))) return UPLOAD_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}
