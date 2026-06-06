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
  // Serve admin-side uploads (currently FAQ photos/videos) under
  // `/uploads/*`. Files live on disk in `data/uploads/<feature>/...`
  // and are referenced by the corresponding entity (e.g. `FaqItem.mediaUrls`).
  // The path is intentionally OUTSIDE the `/api` prefix so the SPA
  // can render `<img src="/uploads/faq/...">` directly without auth.
  const uploadsRoot = resolveUploadsRoot();
  app.useStaticAssets(uploadsRoot, {
    prefix: '/uploads',
    maxAge: '1y',
    immutable: true,
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
}

function resolveUploadsRoot(): string {
  const fromEnv = process.env.ADMIN_UPLOADS_DIR;
  if (fromEnv && fromEnv.trim().length > 0) {
    return resolve(fromEnv);
  }
  return resolve(process.cwd(), 'data', 'uploads');
}

void bootstrap();
