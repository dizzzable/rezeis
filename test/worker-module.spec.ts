import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INestApplicationContext, Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { WORKER_METADATA } from '@nestjs/bullmq/dist/bull.constants';
import { NestFactory } from '@nestjs/core';

import { ObservabilityModule } from '../src/common/observability/observability.module';
import { SERIAL_WORKER_PROCESSOR_CONCURRENCY } from '../src/common/queue/worker-concurrency';
import {
  BullMqGlobalConcurrencyError,
  SERIAL_QUEUE_GLOBAL_CONCURRENCY,
  applySerialBullMqGlobalConcurrency,
  runBullMqGlobalConcurrencyWithTimeout,
} from '../src/common/queue/bullmq-global-concurrency';
import { BackupModule } from '../src/modules/backup/backup.module';
import { BroadcastModule } from '../src/modules/broadcast/broadcast.module';
import { DashboardModule } from '../src/modules/dashboard/dashboard.module';
import { GovernanceModule } from '../src/modules/governance/governance.module';
import { HealthModule } from '../src/modules/health/health.module';
import { ImportsModule } from '../src/modules/imports/imports.module';
import { InternalUserModule } from '../src/modules/internal-user/internal-user.module';
import { MetricsModule } from '../src/modules/metrics/metrics.module';
import { PartnersModule } from '../src/modules/partners/partners.module';
import { PaymentsModule } from '../src/modules/payments/payments.module';
import { PaymentsSharedModule } from '../src/modules/payments/payments-shared.module';
import { PaymentsWorkerModule } from '../src/modules/payments/payments-worker.module';
import { PaymentReconciliationProcessor } from '../src/modules/payments/processors/payment-reconciliation.processor';
import { PaymentWorkerQueueConcurrencyService } from '../src/modules/payments/services/payment-worker-queue-concurrency.service';
import { ProfileSyncProcessor } from '../src/modules/payments/processors/profile-sync.processor';
import { PlansModule } from '../src/modules/plans/plans.module';
import { PromocodesModule } from '../src/modules/promocodes/promocodes.module';
import { ReferralsModule } from '../src/modules/referrals/referrals.module';
import { ReferralsWorkerModule } from '../src/modules/referrals/referrals-worker.module';
import { RemnawaveModule } from '../src/modules/remnawave/remnawave.module';
import { RemnawaveWorkerModule } from '../src/modules/remnawave/remnawave-worker.module';
import { SettingsModule } from '../src/modules/settings/settings.module';
import { SubscriptionsModule } from '../src/modules/subscriptions/subscriptions.module';
import { NotificationDeliveryProcessor } from '../src/modules/user-activity/processors/notification-delivery.processor';
import { UserActivityWorkerQueueConcurrencyService } from '../src/modules/user-activity/services/user-activity-worker-queue-concurrency.service';
import { UserActivityModule } from '../src/modules/user-activity/user-activity.module';
import { UserActivitySharedModule } from '../src/modules/user-activity/user-activity-shared.module';
import { UserActivityWorkerModule } from '../src/modules/user-activity/user-activity-worker.module';
import { UsersModule } from '../src/modules/users/users.module';

function getModuleImports(moduleType: object): readonly unknown[] {
  return (Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleType) as readonly unknown[] | undefined) ?? [];
}

describe('WorkerModule', () => {
  it('uses a dedicated worker root instead of the full admin API module graph', async () => {
    Object.assign(process.env, createValidEnvironmentVariables());
    const { WorkerModule } = await import('../src/worker.module');
    const imports = getModuleImports(WorkerModule);

    assert.ok(imports.includes(PaymentsWorkerModule));
    assert.ok(imports.includes(UserActivityWorkerModule));
    assert.ok(!imports.includes(PaymentsModule));
    assert.ok(!imports.includes(UserActivityModule));
    assert.ok(!imports.some((moduleImport) => typeof moduleImport === 'function' && moduleImport.name === 'AppModule'));

    for (const webOnlyModule of [
      BackupModule,
      BroadcastModule,
      DashboardModule,
      GovernanceModule,
      HealthModule,
      ImportsModule,
      InternalUserModule,
      MetricsModule,
      PartnersModule,
      PlansModule,
      PromocodesModule,
      ReferralsModule,
      RemnawaveModule,
      SettingsModule,
      SubscriptionsModule,
      UsersModule,
    ]) {
      assert.ok(!imports.includes(webOnlyModule), `${webOnlyModule.name} must not be a root worker import`);
    }
  });

  it('keeps processor-bearing feature modules separate from admin API controllers', () => {
    const paymentWorkerControllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, PaymentsWorkerModule) as readonly unknown[] | undefined;
    const userActivityWorkerControllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, UserActivityWorkerModule) as readonly unknown[] | undefined;
    const remnawaveWorkerControllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, RemnawaveWorkerModule) as readonly unknown[] | undefined;
    const referralsWorkerControllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ReferralsWorkerModule) as readonly unknown[] | undefined;

    assert.deepEqual(paymentWorkerControllers ?? [], []);
    assert.deepEqual(userActivityWorkerControllers ?? [], []);
    assert.deepEqual(remnawaveWorkerControllers ?? [], []);
    assert.deepEqual(referralsWorkerControllers ?? [], []);
  });

  it('keeps payment worker dependencies on worker-safe modules instead of full API modules', () => {
    const paymentWorkerImports = getModuleImports(PaymentsWorkerModule);

    assert.ok(paymentWorkerImports.includes(PaymentsSharedModule));
    assert.ok(!paymentWorkerImports.includes(RemnawaveWorkerModule));
    assert.ok(!paymentWorkerImports.includes(ReferralsWorkerModule));
    assert.ok(!paymentWorkerImports.includes(UserActivityWorkerModule));
    assert.ok(!paymentWorkerImports.includes(RemnawaveModule));
    assert.ok(!paymentWorkerImports.includes(ReferralsModule));
    assert.ok(!paymentWorkerImports.includes(UserActivityModule));
  });

  it('keeps admin API modules on shared feature seams instead of worker processor modules', () => {
    const paymentApiImports = getModuleImports(PaymentsModule);
    const userActivityApiImports = getModuleImports(UserActivityModule);

    assert.ok(paymentApiImports.includes(PaymentsSharedModule));
    assert.ok(!paymentApiImports.includes(PaymentsWorkerModule));
    assert.ok(userActivityApiImports.includes(UserActivitySharedModule));
    assert.ok(!userActivityApiImports.includes(UserActivityWorkerModule));
  });

  it('keeps shared feature seams processor-free while exposing queue/service dependencies', () => {
    const paymentSharedProviders = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, PaymentsSharedModule) as readonly unknown[] | undefined;
    const paymentSharedImports = getModuleImports(PaymentsSharedModule);
    const userActivitySharedProviders = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, UserActivitySharedModule) as readonly unknown[] | undefined;
    const userActivitySharedImports = getModuleImports(UserActivitySharedModule);

    assert.ok(paymentSharedImports.includes(RemnawaveWorkerModule));
    assert.ok(paymentSharedImports.includes(ReferralsWorkerModule));
    assert.ok(paymentSharedImports.includes(UserActivitySharedModule));
    assert.ok(!paymentSharedImports.includes(UserActivityWorkerModule));
    assert.ok(!paymentSharedProviders?.includes(PaymentReconciliationProcessor));
    assert.ok(!paymentSharedProviders?.includes(ProfileSyncProcessor));
    assert.ok(!paymentSharedProviders?.includes(PaymentWorkerQueueConcurrencyService));

    assert.ok(!userActivitySharedImports.includes(ObservabilityModule));
    assert.ok(!userActivitySharedProviders?.includes(NotificationDeliveryProcessor));
    assert.ok(!userActivitySharedProviders?.includes(UserActivityWorkerQueueConcurrencyService));
  });

  it('pins side-effect worker processors to explicit serial concurrency', () => {
    for (const processor of [
      PaymentReconciliationProcessor,
      ProfileSyncProcessor,
      NotificationDeliveryProcessor,
    ]) {
      assert.deepEqual(Reflect.getMetadata(WORKER_METADATA, processor), {
        concurrency: SERIAL_WORKER_PROCESSOR_CONCURRENCY,
      });
    }
  });

  it('applies explicit serial global concurrency to worker queues during bootstrap', async () => {
    const calls: Array<{ queue: string; concurrency: number }> = [];
    const paymentReconciliationQueue = createGlobalConcurrencyQueue('payment-reconciliation', calls);
    const profileSyncQueue = createGlobalConcurrencyQueue('profile-sync', calls);
    const notificationDeliveryQueue = createGlobalConcurrencyQueue('notification-delivery', calls);

    await new PaymentWorkerQueueConcurrencyService(
      paymentReconciliationQueue as never,
      profileSyncQueue as never,
    ).onApplicationBootstrap();
    await new UserActivityWorkerQueueConcurrencyService(notificationDeliveryQueue as never).onApplicationBootstrap();

    assert.deepEqual(calls, [
      { queue: 'payment-reconciliation', concurrency: SERIAL_QUEUE_GLOBAL_CONCURRENCY },
      { queue: 'profile-sync', concurrency: SERIAL_QUEUE_GLOBAL_CONCURRENCY },
      { queue: 'notification-delivery', concurrency: SERIAL_QUEUE_GLOBAL_CONCURRENCY },
    ]);
  });

  it('uses the bounded BullMQ global concurrency helper without exposing queue internals', async () => {
    const calls: number[] = [];

    await applySerialBullMqGlobalConcurrency({
      setGlobalConcurrency: async (concurrency: number): Promise<number> => {
        calls.push(concurrency);

        return concurrency;
      },
    });

    assert.deepEqual(calls, [SERIAL_QUEUE_GLOBAL_CONCURRENCY]);
  });

  it('bounds stalled BullMQ global concurrency setup', async () => {
    const startedAt = Date.now();

    await assert.rejects(
      applySerialBullMqGlobalConcurrency(
        {
          setGlobalConcurrency: () => new Promise<number>(() => undefined),
        },
        5,
      ),
      BullMqGlobalConcurrencyError,
    );

    assert.ok(Date.now() - startedAt < 50, 'stalled global concurrency setup must return before the inner promise resolves');
  });

  it('sanitizes BullMQ global concurrency setup failures', async () => {
    const rawFailure = new Error('redis://admin:secret-password@redis.internal/0 job payload provider-token');

    await assert.rejects(
      applySerialBullMqGlobalConcurrency(
        {
          setGlobalConcurrency: async (): Promise<number> => {
            throw rawFailure;
          },
        },
        100,
      ),
      (error: unknown): boolean => {
        assert.ok(error instanceof BullMqGlobalConcurrencyError);
        const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
        assert.ok(!serialized.includes('secret-password'));
        assert.ok(!serialized.includes('redis://'));
        assert.ok(!serialized.includes('provider-token'));
        assert.ok(!serialized.includes('job payload'));

        return true;
      },
    );
  });

  it('sanitizes synchronous BullMQ global concurrency setup throws', async () => {
    const rawFailure = new Error('redis://admin:secret-password@redis.internal/0 job payload provider-token');

    await assert.rejects(
      applySerialBullMqGlobalConcurrency(
        {
          setGlobalConcurrency: (): Promise<number> => {
            throw rawFailure;
          },
        },
        100,
      ),
      (error: unknown): boolean => {
        assert.ok(error instanceof BullMqGlobalConcurrencyError);
        const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
        assert.ok(!serialized.includes('secret-password'));
        assert.ok(!serialized.includes('redis://'));
        assert.ok(!serialized.includes('provider-token'));
        assert.ok(!serialized.includes('job payload'));

        return true;
      },
    );
  });

  it('keeps BullMQ global concurrency timeout helper successful for completed setup', async () => {
    await runBullMqGlobalConcurrencyWithTimeout(() => Promise.resolve(), 5);
  });

  it('bootstraps the worker with the dedicated root and preserves lifecycle hooks', async () => {
    Object.assign(process.env, createValidEnvironmentVariables());
    const { WorkerModule } = await import('../src/worker.module');
    const { bootstrapWorker } = await import('../src/worker');
    const originalCreateApplicationContext = NestFactory.createApplicationContext;
    const originalProcessOnce = process.once;
    const registeredSignals = new Map<NodeJS.Signals, () => void>();
    let usedRootModule: unknown;
    let shutdownHooksEnabled = false;
    let contextClosed = false;

    (NestFactory as unknown as MutableNestFactory).createApplicationContext = async (
      moduleType: unknown,
    ): Promise<INestApplicationContext> => {
      usedRootModule = moduleType;

      return {
        enableShutdownHooks: (): void => {
          shutdownHooksEnabled = true;
        },
        close: async (): Promise<void> => {
          contextClosed = true;
        },
      } as INestApplicationContext;
    };

    process.once = ((signal: NodeJS.Signals, listener: () => void): NodeJS.Process => {
      registeredSignals.set(signal, listener);

      return process;
    }) as typeof process.once;

    try {
      const bootstrapPromise = bootstrapWorker(5);
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(usedRootModule, WorkerModule);
      assert.equal(shutdownHooksEnabled, true);
      assert.ok(registeredSignals.has('SIGINT'));
      assert.ok(registeredSignals.has('SIGTERM'));
      assert.ok(registeredSignals.has('SIGBREAK'));

      registeredSignals.get('SIGBREAK')?.();
      await bootstrapPromise;

      assert.equal(contextClosed, true);
      assert.equal(JSON.stringify({ value: 123n }), '{"value":"123"}');
    } finally {
      (NestFactory as unknown as MutableNestFactory).createApplicationContext =
        originalCreateApplicationContext as MutableNestFactory['createApplicationContext'];
      process.once = originalProcessOnce;
    }
  });

  it('bounds worker application-context close during shutdown', async () => {
    const { runWorkerApplicationCloseWithTimeout, WorkerApplicationCloseError } = await import('../src/worker');
    const startedAt = Date.now();

    await assert.rejects(
      runWorkerApplicationCloseWithTimeout(() => new Promise<void>(() => undefined), 5),
      WorkerApplicationCloseError,
    );

    assert.ok(Date.now() - startedAt < 50, 'worker close must return before a stalled close operation resolves');
  });

  it('sanitizes worker application-context close failures', async () => {
    const { runWorkerApplicationCloseWithTimeout, WorkerApplicationCloseError } = await import('../src/worker');
    const rawFailure = new Error('redis://admin:secret-password@redis.internal/0 provider-token job payload');

    await assert.rejects(
      runWorkerApplicationCloseWithTimeout(() => Promise.reject(rawFailure), 100),
      (error: unknown): boolean => {
        assert.ok(error instanceof WorkerApplicationCloseError);
        const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
        assert.ok(!serialized.includes('secret-password'));
        assert.ok(!serialized.includes('redis://'));
        assert.ok(!serialized.includes('provider-token'));
        assert.ok(!serialized.includes('job payload'));

        return true;
      },
    );
  });

  it('sanitizes synchronous worker application-context close failures', async () => {
    const { runWorkerApplicationCloseWithTimeout, WorkerApplicationCloseError } = await import('../src/worker');
    const rawFailure = new Error('redis://admin:secret-password@redis.internal/0 provider-token job payload');

    await assert.rejects(
      runWorkerApplicationCloseWithTimeout((): Promise<void> => {
        throw rawFailure;
      }, 100),
      (error: unknown): boolean => {
        assert.ok(error instanceof WorkerApplicationCloseError);
        const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
        assert.ok(!serialized.includes('secret-password'));
        assert.ok(!serialized.includes('redis://'));
        assert.ok(!serialized.includes('provider-token'));
        assert.ok(!serialized.includes('job payload'));

        return true;
      },
    );
  });

  it('uses bounded worker close from the bootstrap shutdown path', async () => {
    Object.assign(process.env, createValidEnvironmentVariables());
    const { bootstrapWorker, WorkerApplicationCloseError } = await import('../src/worker');
    const originalCreateApplicationContext = NestFactory.createApplicationContext;
    const originalProcessOnce = process.once;
    const registeredSignals = new Map<NodeJS.Signals, () => void>();

    (NestFactory as unknown as MutableNestFactory).createApplicationContext = async (): Promise<INestApplicationContext> => ({
      enableShutdownHooks: (): void => undefined,
      close: () => new Promise<void>(() => undefined),
    }) as INestApplicationContext;

    process.once = ((signal: NodeJS.Signals, listener: () => void): NodeJS.Process => {
      registeredSignals.set(signal, listener);

      return process;
    }) as typeof process.once;

    try {
      const bootstrapPromise = bootstrapWorker(5);
      await new Promise((resolve) => setImmediate(resolve));
      registeredSignals.get('SIGTERM')?.();

      await assert.rejects(bootstrapPromise, WorkerApplicationCloseError);
    } finally {
      (NestFactory as unknown as MutableNestFactory).createApplicationContext =
        originalCreateApplicationContext as MutableNestFactory['createApplicationContext'];
      process.once = originalProcessOnce;
    }
  });

  it('bounds worker application-context bootstrap creation', async () => {
    const { runWorkerApplicationBootstrapWithTimeout, WorkerApplicationBootstrapError } = await import('../src/worker');
    const startedAt = Date.now();

    await assert.rejects(
      runWorkerApplicationBootstrapWithTimeout(() => new Promise<INestApplicationContext>(() => undefined), 5),
      WorkerApplicationBootstrapError,
    );

    assert.ok(Date.now() - startedAt < 50, 'worker bootstrap must return before a stalled application-context creation resolves');
  });

  it('sanitizes worker application-context bootstrap failures', async () => {
    const { runWorkerApplicationBootstrapWithTimeout, WorkerApplicationBootstrapError } = await import('../src/worker');
    const rawFailure = new Error('redis://admin:secret-password@redis.internal/0 provider-token job payload');

    await assert.rejects(
      runWorkerApplicationBootstrapWithTimeout(() => Promise.reject(rawFailure), 100),
      (error: unknown): boolean => {
        assert.ok(error instanceof WorkerApplicationBootstrapError);
        const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
        assert.ok(!serialized.includes('secret-password'));
        assert.ok(!serialized.includes('redis://'));
        assert.ok(!serialized.includes('provider-token'));
        assert.ok(!serialized.includes('job payload'));

        return true;
      },
    );
  });

  it('sanitizes synchronous worker application-context bootstrap failures', async () => {
    const { runWorkerApplicationBootstrapWithTimeout, WorkerApplicationBootstrapError } = await import('../src/worker');
    const rawFailure = new Error('redis://admin:secret-password@redis.internal/0 provider-token job payload');

    await assert.rejects(
      runWorkerApplicationBootstrapWithTimeout((): Promise<INestApplicationContext> => {
        throw rawFailure;
      }, 100),
      (error: unknown): boolean => {
        assert.ok(error instanceof WorkerApplicationBootstrapError);
        const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
        assert.ok(!serialized.includes('secret-password'));
        assert.ok(!serialized.includes('redis://'));
        assert.ok(!serialized.includes('provider-token'));
        assert.ok(!serialized.includes('job payload'));

        return true;
      },
    );
  });

  it('uses bounded worker bootstrap from the real bootstrap path', async () => {
    Object.assign(process.env, createValidEnvironmentVariables());
    const { bootstrapWorker, WorkerApplicationBootstrapError } = await import('../src/worker');
    const originalCreateApplicationContext = NestFactory.createApplicationContext;

    (NestFactory as unknown as MutableNestFactory).createApplicationContext = async (): Promise<INestApplicationContext> =>
      new Promise<INestApplicationContext>(() => undefined);

    try {
      await assert.rejects(bootstrapWorker(5, 5), WorkerApplicationBootstrapError);
    } finally {
      (NestFactory as unknown as MutableNestFactory).createApplicationContext =
        originalCreateApplicationContext as MutableNestFactory['createApplicationContext'];
    }
  });

  it('keeps sanitized worker bootstrap failure diagnostics', async () => {
    const { handleWorkerBootstrapFailure } = await import('../src/worker');
    const originalError = Logger.prototype.error;
    const originalExitCode = process.exitCode;
    const calls: Array<{ message: unknown; trace: unknown }> = [];

    Logger.prototype.error = function captureError(message: unknown, trace?: unknown): void {
      calls.push({ message, trace });
    };

    try {
      const failure = new Error('redis://admin:secret-password@redis.internal/0 provider-token job payload');
      handleWorkerBootstrapFailure(failure);

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.message, 'Worker bootstrap failed');
      assert.equal(calls[0]?.trace, undefined);
      const serialized = JSON.stringify(calls);
      assert.ok(!serialized.includes('secret-password'));
      assert.ok(!serialized.includes('redis://'));
      assert.ok(!serialized.includes('provider-token'));
      assert.ok(!serialized.includes('job payload'));
      assert.equal(process.exitCode, 1);
    } finally {
      Logger.prototype.error = originalError;
      process.exitCode = originalExitCode;
    }
  });
});

function createGlobalConcurrencyQueue(
  queue: string,
  calls: Array<{ queue: string; concurrency: number }>,
): { setGlobalConcurrency(concurrency: number): Promise<number> } {
  return {
    setGlobalConcurrency: async (concurrency: number): Promise<number> => {
      calls.push({ queue, concurrency });

      return concurrency;
    },
  };
}

type MutableNestFactory = {
  createApplicationContext: (...args: unknown[]) => Promise<INestApplicationContext>;
};

function createValidEnvironmentVariables(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    DATABASE_URL: 'postgresql://rezeis:secret@localhost:5432/rezeis',
    REDIS_URL: 'redis://localhost:6379/0',
    REZEIS_ADMIN_CORS_ORIGIN: 'http://localhost:3000',
    REZEIS_ADMIN_JWT_SECRET: 'jwt-secret',
    REZEIS_ADMIN_JWT_EXPIRES_IN: '12h',
    REZEIS_ADMIN_INTERNAL_API_KEY: 'internal-api-key',
    REZEIS_ADMIN_SMTP_HOST: 'smtp.example.com',
    REZEIS_ADMIN_SMTP_PORT: '465',
    REZEIS_ADMIN_SMTP_SECURE: 'true',
    REZEIS_ADMIN_SMTP_USER: 'smtp-user',
    REZEIS_ADMIN_SMTP_PASSWORD: 'smtp-password',
    REZEIS_ADMIN_SMTP_FROM_ADDRESS: 'no-reply@example.com',
    REZEIS_ADMIN_SMTP_FROM_NAME: 'Rezeis Admin',
    REZEIS_ADMIN_SMTP_REPLY_TO: 'support@example.com',
    REZEIS_ADMIN_SMTP_TIMEOUT_MS: '10000',
  };
}
