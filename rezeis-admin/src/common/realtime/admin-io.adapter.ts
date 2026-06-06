import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

import { buildCorsOptions, type CorsOriginConfig } from '../http/cors-origin';

/**
 * Socket.IO adapter that applies the same trusted-origin CORS allowlist as
 * the HTTP server (`ADMIN_CORS_ORIGINS`).
 *
 * Why: the realtime gateway authenticates with an admin JWT carried on the
 * handshake and runs with `credentials: true`. Without an explicit origin
 * allowlist the WebSocket endpoint would accept credentialed browser
 * handshakes from ANY origin, undermining the HTTP CORS hardening (S1). The
 * gateway decorator can only express a static `cors` value, so we inject the
 * runtime-validated origins here, where the parsed config is available.
 */
export class AdminIoAdapter extends IoAdapter {
  private readonly corsOrigins: CorsOriginConfig;

  public constructor(app: INestApplicationContext, corsOrigins: CorsOriginConfig) {
    super(app);
    this.corsOrigins = corsOrigins;
  }

  public createIOServer(port: number, options?: ServerOptions) {
    const corsOptions = buildCorsOptions(this.corsOrigins);
    return super.createIOServer(port, {
      ...(options ?? {}),
      cors: {
        origin: corsOptions.origin,
        credentials: corsOptions.credentials,
        methods: corsOptions.methods,
      },
    });
  }
}
