import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

import type { HttpModuleOptions } from '@nestjs/axios';

export const OUTBOUND_HTTP_TIMEOUT_MS = 45_000;
export const OUTBOUND_HTTP_MAX_REDIRECTS = 5;
export const OUTBOUND_HTTP_MAX_BODY_BYTES = 1_048_576;
export const OUTBOUND_HTTP_MAX_SOCKETS = 64;
export const OUTBOUND_HTTP_MAX_FREE_SOCKETS = 16;

export function buildBoundedOutboundHttpOptions(): HttpModuleOptions {
  return {
    timeout: OUTBOUND_HTTP_TIMEOUT_MS,
    maxRedirects: OUTBOUND_HTTP_MAX_REDIRECTS,
    maxContentLength: OUTBOUND_HTTP_MAX_BODY_BYTES,
    maxBodyLength: OUTBOUND_HTTP_MAX_BODY_BYTES,
    httpAgent: new HttpAgent({
      keepAlive: true,
      maxSockets: OUTBOUND_HTTP_MAX_SOCKETS,
      maxFreeSockets: OUTBOUND_HTTP_MAX_FREE_SOCKETS,
    }),
    httpsAgent: new HttpsAgent({
      keepAlive: true,
      maxSockets: OUTBOUND_HTTP_MAX_SOCKETS,
      maxFreeSockets: OUTBOUND_HTTP_MAX_FREE_SOCKETS,
    }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  };
}
