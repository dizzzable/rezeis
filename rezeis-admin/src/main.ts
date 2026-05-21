import 'reflect-metadata';

import { resolve } from 'node:path';

import { ValidationPipe } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { appConfig } from './common/config/app.config';
import { AdminSafeExceptionFilter } from './common/filters/admin-safe-exception.filter';
import { SystemLogsService } from './modules/system-logs/services/system-logs.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
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

  app.use(helmet());
  // Trust the first proxy hop so `req.ip` reflects the real client IP
  // when rezeis-admin runs behind nginx / Caddy in docker-compose.
  // The `BlockedIpGuard` and audit log rely on this for accurate IPs.
  const httpAdapter = app.getHttpAdapter().getInstance() as { set?: (key: string, value: unknown) => void };
  if (typeof httpAdapter.set === 'function') {
    httpAdapter.set('trust proxy', 1);
  }
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  });
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

  const swaggerConfiguration = new DocumentBuilder()
    .setTitle('Rezeis Admin API')
    .setDescription('Internal API surface for Rezeis Admin')
    .setVersion('1.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfiguration);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

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
