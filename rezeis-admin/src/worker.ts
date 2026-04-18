import 'reflect-metadata';

import { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

const WORKER_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

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
  const logger = new Logger('WorkerBootstrap');
  const applicationContext: INestApplicationContext = await NestFactory.createApplicationContext(
    AppModule,
  );

  applicationContext.enableShutdownHooks();
  logger.log('Worker context started');

  await createShutdownPromise(logger);
  await applicationContext.close();
}

void bootstrapWorker().catch((err: unknown): void => {
  const logger = new Logger('WorkerBootstrap');

  logger.error('Worker bootstrap failed', err instanceof Error ? err.stack : undefined);
  process.exitCode = 1;
});
