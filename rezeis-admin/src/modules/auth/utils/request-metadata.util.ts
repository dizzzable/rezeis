import { Request } from 'express';

import { RequestMetadataInterface } from '../interfaces/request-metadata.interface';

/**
 * Extracts normalized request metadata from an HTTP request.
 */
export function extractRequestMetadata(request: Request): RequestMetadataInterface {
  return {
    requestId: normalizeHeaderValue(request.headers['x-request-id']),
    remoteAddress: resolveRemoteAddress(request),
    userAgent: normalizeHeaderValue(request.headers['user-agent']),
  };
}

function normalizeHeaderValue(headerValue: string | string[] | undefined): string | null {
  if (typeof headerValue === 'string') {
    return headerValue;
  }
  if (Array.isArray(headerValue) && headerValue.length > 0) {
    return headerValue[0] ?? null;
  }
  return null;
}

function resolveRemoteAddress(request: Request): string | null {
  // `req.ip` already honours `app.set('trust proxy', ADMIN_TRUST_PROXY)`:
  // when the proxy chain is trusted Express derives the client IP from
  // `X-Forwarded-For` itself; when it is NOT trusted the header is ignored.
  // Parsing `X-Forwarded-For` here unconditionally (as we used to) let any
  // client spoof the header — bypassing the login fail2ban counter and even
  // auto-banning a victim's real IP. Mirror `blocked-ip.guard.ts::extractIp`.
  if (typeof request.ip === 'string' && request.ip.length > 0) {
    // Strip the IPv4-mapped IPv6 prefix Node injects for v4 clients
    // (`::ffff:1.2.3.4` → `1.2.3.4`).
    return request.ip.replace(/^::ffff:/, '');
  }
  const remote: string | undefined = request.socket.remoteAddress;
  if (typeof remote === 'string' && remote.length > 0) {
    return remote.replace(/^::ffff:/, '');
  }
  return null;
}
