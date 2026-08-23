import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { AdminIpAllowlistService } from '../services/admin-ip-allowlist.service';

/** Already lower-case: `isAdminApiPath()` lower-cases the candidate, not this. */
const ADMIN_API_PATH_PREFIX = '/api/admin/';

/** `scheme "://"` at the head of an absolute-form request-target (RFC 3986 §3.1). */
const ABSOLUTE_FORM_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

/**
 * Admin IP Allowlist guard. Wired as `APP_GUARD` so it runs before any
 * controller-level guard. Only matches requests whose URL path starts
 * with `/api/admin/`; the internal API and the user-facing `/api/internal`
 * paths are never subject to the allowlist.
 *
 * The candidate is the request-target's PATH, and the test on it is
 * CASE-INSENSITIVE. Both halves are load-bearing rather than tidy, and each was
 * a separate live bypass of the same shape: the guard decided "not an admin
 * endpoint" about a request the Express router then handed to an admin
 * handler, took the `return true` on the first line, and never asked the
 * allowlist at all.
 *
 *   - CASE. Express routes case-insensitively unless `case sensitive routing`
 *     is enabled, and this app never enables it, so `GET /api/ADMIN/auth/login`
 *     reaches the very same handler as `/api/admin/auth/login`. While this
 *     guard compared with a case-sensitive `startsWith`, changing one letter's
 *     case was the whole bypass.
 *   - SHAPE. `originalUrl` is the raw request-target, and RFC 7230 §5.3.2
 *     allows a second spelling of it that Node accepts and Express routes:
 *     absolute-form, `GET http://host/api/admin/... HTTP/1.1`. There
 *     `originalUrl` is the WHOLE URI, so no prefix test on it can match, while
 *     the router keeps dispatching on `parseurl(req).pathname` — which is just
 *     `/api/admin/...`. Measured against this app before the fix:
 *
 *         ORIGIN-FORM   -> 403 Forbidden | allowlist asked: 1
 *         ABSOLUTE-FORM -> 200 OK        | allowlist asked: 0
 *
 *     `requestPathname()` below reduces both spellings to the same string the
 *     router matches on, so the guard and the router can no longer disagree
 *     about which requests are admin requests.
 *
 * Fail-open behavior: on infra errors (DB unavailable etc.) we let the
 * request through. The same trade-off as `BlockedIpGuard` — operators
 * must be reachable during transient outages. Four cases fail open and are
 * deliberate: an empty allowlist, an allowlist whose entries are all
 * deactivated (both decided inside `AdminIpAllowlistService`), a DB error,
 * and a request with no derivable client IP. Deciding the prefix correctly
 * does not change any of them; it only decides which requests get asked.
 */
@Injectable()
export class AdminIpAllowlistGuard implements CanActivate {
  public constructor(private readonly allowlistService: AdminIpAllowlistService) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest<Request>();
    const target = request.originalUrl ?? request.url ?? '';
    // Only enforce on admin endpoints — decided on the PATH the router
    // dispatches on, not on the raw target, which in absolute-form carries a
    // scheme and an authority in front of that path. Lower-cased as well: the
    // router matches the path case-insensitively, so a case-sensitive test
    // here decides "not an admin endpoint" for URLs the admin controllers do
    // in fact serve. `toLowerCase()` (not `toLocaleLowerCase()`) so the answer
    // never depends on the server locale.
    if (!isAdminApiPath(requestPathname(target))) return true;

    const ipAddress = extractClientIp(request);
    if (!ipAddress) return true;

    try {
      const allowed = await this.allowlistService.isRequestAllowed(ipAddress);
      if (!allowed) {
        throw new ForbiddenException('Your IP is not allowed to access the admin panel');
      }
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      // Fail-open on infra errors.
      return true;
    }
  }
}

/**
 * The path portion of a raw HTTP request-target — the same string the Express
 * router matches on (`parseurl(req).pathname`).
 *
 * Two forms reach an origin server (RFC 7230 §5.3) and both are handled here,
 * because Node accepts both and Express routes both:
 *
 *   - origin-form   `/api/admin/users?q=1`
 *   - absolute-form `http://host/api/admin/users?q=1`
 *
 * What it deliberately does NOT do is normalise. No dot-segment collapsing, no
 * percent-decoding, no duplicate-slash squashing — because the router does not
 * do any of those either, and the single property that keeps this guard honest
 * is that its answer and the router's answer are the same string. Verified
 * against the installed Express 5.2.1: `//api/admin/`, `/api//admin/`,
 * `/api/./admin/`, `/api/x/../admin/`, `/api/%61dmin/`, `/api/admin./`,
 * `/api/admin/x;a=1` and a Cyrillic-homoglyph `аdmin` all fail to route at all,
 * so normalising or decoding any of them here would only invent admin requests
 * that do not exist. Note which way that error runs: `new URL(target, base)`
 * looks like the obvious implementation and is the wrong one — it reads
 * `//api/admin/x` as a protocol-relative URL and answers `/admin/x`, throwing
 * the `/api` away and manufacturing a fresh bypass out of a request Express
 * only ever 404s.
 */
function requestPathname(target: string): string {
  if (target.length === 0) return target;
  // origin-form — the overwhelmingly common case, and the only one a browser
  // or a reverse proxy produces.
  if (target.startsWith('/')) return stripQueryAndFragment(target);

  const scheme = ABSOLUTE_FORM_SCHEME.exec(target);
  // Anything else is authority-form (CONNECT), asterisk-form (`OPTIONS *`) or
  // malformed. None of them address a path, so the value goes back unchanged
  // and the prefix test says "not an admin endpoint" about it.
  if (!scheme) return target;

  const afterScheme = target.slice(scheme[0].length);
  // Userinfo, host and port cannot contain an unescaped `/`, `?` or `#`, so
  // the first of those three ends the authority.
  const pathStart = afterScheme.search(/[/?#]/u);
  if (pathStart === -1 || !afterScheme.startsWith('/', pathStart)) return '/';
  return stripQueryAndFragment(afterScheme.slice(pathStart));
}

function stripQueryAndFragment(path: string): string {
  const end = path.search(/[?#]/u);
  return end === -1 ? path : path.slice(0, end);
}

/**
 * True when `path` addresses `/api/admin/*`. The query string and fragment are
 * already gone by the time this runs, so only the prefix is examined and
 * nothing after the path can affect the answer.
 */
function isAdminApiPath(path: string): boolean {
  return path.toLowerCase().startsWith(ADMIN_API_PATH_PREFIX);
}

function extractClientIp(request: Request): string | null {
  if (typeof request.ip === 'string' && request.ip.length > 0) {
    return request.ip.replace(/^::ffff:/, '');
  }
  const remote = request.socket?.remoteAddress;
  if (typeof remote === 'string' && remote.length > 0) {
    return remote.replace(/^::ffff:/, '');
  }
  return null;
}
