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
  const forwardedForHeader: string | null = normalizeHeaderValue(request.headers['x-forwarded-for']);
  if (forwardedForHeader) {
    const forwardedAddress: string | undefined = forwardedForHeader.split(',')[0]?.trim();
    return forwardedAddress ?? null;
  }
  return request.ip || request.socket.remoteAddress || null;
}
