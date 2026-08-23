import 'reflect-metadata';

import { resolve } from 'node:path';

import { ValidationPipe } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { appConfig } from './common/config/app.config';
import { AdminSafeExceptionFilter } from './common/filters/admin-safe-exception.filter';
import { shouldEnableApiDocs } from './common/http/api-docs';
import { configureBoundedBodyParsers } from './common/http/body-parser-limits';
import { buildCorsOptions } from './common/http/cors-origin';
import { configureHttpRuntimeMiddleware } from './common/http/configure-http-runtime';
import { RequestTimeoutMiddleware } from './common/middleware/request-timeout.middleware';
import { AdminIoAdapter } from './common/realtime/admin-io.adapter';
import { configureBigIntJsonSerialization } from './common/runtime/bigint-json';
import { warnOnUnreachableCrossHostUrls } from './common/runtime/cross-host-url-check';
import { printRezeisBanner } from './common/runtime/startup-banner';
import { SystemLogsService } from './modules/system-logs/services/system-logs.service';

configureBigIntJsonSerialization();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    rawBody: true,
    bufferLogs: true,
  });
  // Phase 8: install the ring-buffer logger as the global Nest logger
  // so subsequent `Logger.*` calls land in the in-memory buffer that
  // backs the admin "Logs" page. Buffered startup logs are flushed
  // through this same instance.
  const systemLogsService = app.get(SystemLogsService);
  app.useLogger(systemLogsService);
  const appConfiguration: ConfigType<typeof appConfig> = app.get(appConfig.KEY);
  const port: number = appConfiguration.port;
  const host: string = appConfiguration.host;

  configureBoundedBodyParsers(app);
  configureHttpRuntimeMiddleware(app, {
    nodeEnv: process.env.NODE_ENV,
    trustProxy: appConfiguration.trustProxy,
  });
  // Request timeout middleware — 30s default, 120s for uploads/downloads
  const timeoutMiddleware = new RequestTimeoutMiddleware();
  app.use((req: unknown, res: unknown, next: unknown) =>
    timeoutMiddleware.use(req as never, res as never, next as never),
  );
  app.enableCors(buildCorsOptions(appConfiguration.corsOrigins));
  // Apply the same trusted-origin allowlist to the Socket.IO realtime
  // gateway (handshake carries an admin JWT + credentials), so the WebSocket
  // endpoint isn't open to all origins while HTTP CORS is locked down.
  app.useWebSocketAdapter(new AdminIoAdapter(app, appConfiguration.corsOrigins));
  app.setGlobalPrefix('api');
  // Serve admin-side uploads (FAQ photos/videos, custom icons, branding assets,
  // bot banners) under `/uploads/*`. Files live on disk in
  // `data/uploads/<feature>/...` and are referenced by the corresponding entity
  // (e.g. `FaqItem.mediaUrls`). The path is intentionally OUTSIDE the `/api`
  // prefix so the SPA can render `<img src="/uploads/faq/...">` directly
  // without auth — which also puts it outside every Nest guard, interceptor and
  // filter. `setHeaders` is the only place a response header can be attached to
  // these files.
  const uploadsRoot = resolveUploadsRoot();
  app.useStaticAssets(uploadsRoot, {
    prefix: '/uploads',
    maxAge: '1y',
    immutable: true,
    setHeaders: applyUploadResponseHeaders,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  // Phase E2E: install the safe exception filter so unhandled errors
  // get sanitised before they reach the wire AND get a stack-trace
  // line in the in-memory log buffer (instead of the default Nest
  // ExceptionsHandler which emits an empty `{}` payload).
  app.useGlobalFilters(new AdminSafeExceptionFilter());
  app.enableShutdownHooks();

  if (shouldEnableApiDocs({ docsEnabled: appConfiguration.docsEnabled, nodeEnv: process.env.NODE_ENV })) {
    const swaggerConfiguration = new DocumentBuilder()
      .setTitle('Rezeis Admin API')
      .setDescription('Internal API surface for Rezeis Admin')
      .setVersion('1.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT')
      .build();
    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfiguration);
    SwaggerModule.setup('api/docs', app, swaggerDocument);
  }

  await app.listen(port, host);
  // Success banner — printed only once the HTTP listener is actually bound.
  printRezeisBanner('api');
  // Split-VPS guard: warn (never fail) when a cross-host URL still names a
  // docker service that does not resolve from this host. Runs on the api
  // container only — the worker shares the same .env, so a second copy of the
  // same warning would add noise, not information. Returns immediately; the
  // probes themselves run on unref'd timers over the next five minutes.
  warnOnUnreachableCrossHostUrls();
}

/**
 * Response headers for everything under `/uploads`.
 *
 * This is the SECOND layer under the upload validators, and it is deliberately
 * independent of them: `assertSafeSvg` decides what may be written, this
 * decides what a browser may do with what was written. A future gap in the
 * reject-list then costs an upload, not an execution.
 *
 * It has to live here because `/uploads` is `express.static`, outside
 * `setGlobalPrefix('api')` and therefore outside every guard and interceptor,
 * and because the app-wide helmet CSP is `reportOnly` in production and `false`
 * everywhere else (`buildHelmetOptions`) — so nothing was enforcing anything on
 * these paths.
 *
 *   - `Content-Security-Policy: default-src 'none'; sandbox` — an SVG opened as
 *     a top-level document gets no script, no network, and an opaque origin, so
 *     it cannot reach the admin session even if it carries active content.
 *     Set on EVERY upload, not only markup: it costs nothing on a PNG.
 *   - `Content-Disposition: attachment` for markup extensions — navigating to
 *     the file downloads it instead of rendering it in the admin origin.
 *     Subresource loads are unaffected, so `<img src="/uploads/branding/x.svg">`
 *     and the PWA manifest icon still render.
 *   - `X-Content-Type-Options: nosniff` — stops a mislabelled file from being
 *     re-typed into something executable.
 *
 * reiwa proxies these same directories onto the subscriber-facing origin, so
 * every header here protects two origins.
 *
 * Exported for the guarding spec ONLY. It is the single origin of this list:
 * reiwa keeps a hand-copy of it (see the mirror note above), and a spec that
 * re-typed the literals here would go green on a one-sided edit that changed
 * them. Importing this file costs nothing at test time — the bootstrap is
 * behind the `require.main` check at the bottom.
 */
export const MARKUP_UPLOAD_EXTENSIONS: readonly string[] = [
  '.svg',
  '.svgz',
  '.xml',
  '.xhtml',
  '.html',
  '.htm',
  '.xht',
];

export function applyUploadResponseHeaders(
  res: { setHeader(name: string, value: string): void },
  filePath: string,
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  const lower = filePath.toLowerCase();
  if (MARKUP_UPLOAD_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    res.setHeader('Content-Disposition', 'attachment');
  }
}

function resolveUploadsRoot(): string {
  const fromEnv = process.env.ADMIN_UPLOADS_DIR;
  if (fromEnv && fromEnv.trim().length > 0) {
    return resolve(fromEnv);
  }
  return resolve(process.cwd(), 'data', 'uploads');
}

// Start the server only when this file IS the process entrypoint
// (`node dist/main.js`, `nest start app`). Importing it — which the guarding
// test for `applyUploadResponseHeaders` has to do, because `/uploads` is
// configured here and nowhere else — must not stand up a Nest app and open
// database connections. CommonJS output, so `require.main` is the standard
// check; the Dockerfile's `CMD ["node", "dist/main.js"]` satisfies it.
if (require.main === module) {
  void bootstrap();
}
