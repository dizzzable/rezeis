import type { Request } from 'express';

/**
 * The caller's address, resolved exactly once for the whole blocklist feature.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED. `BlockedIpGuard` decides whether an
 * address is refused; `BlockedIpsController` decides whether an operator is
 * about to refuse THEMSELVES. Those two must agree about what "the caller's
 * address" is, or the self-lockout check becomes a second opinion: it would
 * clear an entry the guard then matches, and the operator would be locked out
 * by the very call that told them they were safe.
 *
 * So there is one definition, and both import it.
 */
export function resolveRequestIp(request: Request | undefined): string | null {
  // `req.ip` already honours `app.set('trust proxy', ...)`, which is what makes
  // this correct behind the operator's own reverse proxy.
  const forwarded = readString(request?.ip);
  if (forwarded !== null) return normalizeIp(forwarded);
  // Optional-chained: an Express-shaped object without a live socket is not a
  // reason to throw out of a guard.
  const remote = readString(request?.socket?.remoteAddress);
  return remote === null ? null : normalizeIp(remote);
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * `::ffff:1.2.3.4` → `1.2.3.4`.
 *
 * Node hands the mapped form to a dual-stack listener, and every entry in this
 * feature is compared family-first — so an unstripped mapped address matches
 * nothing at all. The same omission in the cascade classifier let our own exit
 * nodes be recorded as customer addresses.
 */
export function normalizeIp(value: string): string | null {
  const normalized = value.replace(/^::ffff:/, '');
  return normalized.length > 0 ? normalized : null;
}
