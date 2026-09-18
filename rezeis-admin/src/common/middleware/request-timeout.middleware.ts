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
 *   - Plan migration start, preview and retry (/admin/plans/:id/migrations...) - 120s
 *   - Running an automation rule by hand (/admin/automations/rules/:id/run) - 120s
 *
 * This prevents slow/hung requests from consuming worker threads
 * indefinitely and protects against slowloris-style attacks.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

const LONG_TIMEOUT_PATTERNS = [
  // THE FULL CUSTOMER EXPORT. Up to 20 000 rows across 41 columns, plus a walk
  // of the panel's whole device inventory when a device column is ticked. That
  // does not finish in thirty seconds on a real base, and what the operator got
  // instead was a 408 JSON body served under a `text/csv` disposition — while
  // the server kept working and the audit row recorded a successful export they
  // never received.
  /\/admin\/users\/export\//,
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
  // MOVING A PLAN'S SUBSCRIPTIONS BEFORE ITS DELETE: start, preview, retry.
  // Starting locks the plan, resolves every subscription on it (a JSON-path
  // scan no index serves) and inserts the items inside a 60 s transaction
  // (`PLAN_MIGRATION_CREATE_TIMEOUT_MS`); the preview's first page computes the
  // whole plan's summary; a sync retry re-drives failed jobs one by one. The
  // delete dialog waits 120 s for each. At the 30 s default the app answered a
  // 408 while the handler went on and committed: the dialog read "could not
  // start" and stayed on the preview while the move ran, and a large plan could
  // never be previewed at all. The run's status, `current` and the subscription
  // list stay at the default — they are short reads the dialog polls.
  /\/admin\/plans\/[^/?]+\/migrations(?:\/preview|\/[^/?]+\/retry)?(?:[?]|$)/,
  // RUNNING A RULE BY HAND. The run is synchronous — «Запустить сейчас» waits
  // for every action's result — and one rule can outlast thirty seconds on its
  // own: an audience action resolves a cohort and raises a hint for up to five
  // hundred customers one by one, and each `webhook_post` may take its full
  // 10 s. At the default the app answered 408 while the run went on and wrote
  // its execution row, so the operator read a failure for a run that happened.
  // Only the run itself: the rule's reads, save, toggle and execution log stay
  // at the default.
  /\/admin\/automations\/rules\/[^/?]+\/run(?:[?]|$)/,
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
