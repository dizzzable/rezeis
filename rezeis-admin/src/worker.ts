import 'reflect-metadata';

import { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureBigIntJsonSerialization } from './common/runtime/bigint-json';
import { printRezeisBanner } from './common/runtime/startup-banner';
import { getProcessRole } from './common/runtime/process-role.util';

configureBigIntJsonSerialization();

const WORKER_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

/**
 * Worker entrypoint for the rezeis-admin runtime.
 *
 * The worker container loads the FULL `AppModule` so every Nest module —
 * `@Cron` jobs, BullMQ processors, queue producers, system event bridges,
 * Prisma, Realtime gateway, etc. — runs the same code paths it would in
 * the API container. The only behavioural difference is gated by
 * `RUID_PROCESS_ROLE`:
 *
 *   - `worker` — only schedules run; HTTP listener never starts.
 *   - `api`    — schedules are skipped; the API container handles HTTP.
 *   - `all`    — single-container setups (dev). Both run.
 *
 * `worker.ts` simply does NOT call `app.listen()` — Nest still resolves
 * the controllers, but no port is opened, so a worker container won't
 * accidentally receive HTTP traffic.
 */
function createShutdownPromise(logger: Logger): Promise<NodeJS.Signals> {
  return new Promise<NodeJS.Signals>((resolve: (signal: NodeJS.Signals) => void): void => {
    WORKER_SIGNALS.forEach((signal: NodeJS.Signals): void => {
      process.once(signal, (): void => {
        logger.log(`Received ${signal}; shutting down worker`);
        resolve(signal);
      });
    });
  });
}

async function bootstrapWorker(): Promise<void> {
  // The default role for the worker entrypoint is `worker` — admins who
  // want a single-process deployment can flip back to `all` via env, but
  // a process started via `dist/worker.js` should default to "schedules
  // only, no HTTP" semantics.
  if (process.env.RUID_PROCESS_ROLE === undefined || process.env.RUID_PROCESS_ROLE.trim() === '') {
    process.env.RUID_PROCESS_ROLE = 'worker';
  }

  printRezeisBanner('worker');

  const logger = new Logger('WorkerBootstrap');
  logger.log(`Process role: ${getProcessRole()}`);

  const applicationContext: INestApplicationContext =
    await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });

  applicationContext.enableShutdownHooks();
  logger.log('Worker context started; HTTP listener intentionally not bound');

  await createShutdownPromise(logger);
  await applicationContext.close();
  logger.log('Worker context closed cleanly');
}

void bootstrapWorker().catch((err: unknown): void => {
  const logger = new Logger('WorkerBootstrap');
  logger.error('Worker bootstrap failed', err instanceof Error ? err.stack : undefined);
  process.exitCode = 1;
});
