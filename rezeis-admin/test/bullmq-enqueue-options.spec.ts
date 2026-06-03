import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MODULE_METADATA } from '@nestjs/common/constants';

import { redisConfig } from '../src/common/config/redis.config';
import { buildBoundedBullMqDefaultJobOptions, buildBoundedBullMqEnqueueOptions } from '../src/common/queue/bullmq-enqueue-options';
import { QueueModule } from '../src/common/queue/queue.module';
import { PAYMENT_RECONCILIATION_JOB } from '../src/modules/payments/constants/payment-reconciliation.constant';

interface BullRootProvider {
  readonly provide: string;
  readonly inject: readonly string[];
  readonly useFactory: (configuration: { readonly url: string }) => unknown;
}

function getQueueBullRootProvider(): BullRootProvider {
  const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, QueueModule) as Array<{ readonly providers?: readonly unknown[] }>;
  const providers = imports.flatMap((importedModule) => importedModule.providers ?? []);
  const provider = providers.find((candidate): candidate is BullRootProvider => {
    return Boolean(
      candidate &&
        typeof candidate === 'object' &&
        'provide' in candidate &&
        candidate.provide === 'BULLMQ_CONFIG(default)' &&
        'useFactory' in candidate &&
        typeof candidate.useFactory === 'function',
    );
  });

  assert.ok(provider, 'QueueModule should register a BullMQ root provider');
  return provider;
}

describe('buildBoundedBullMqEnqueueOptions', () => {
  it('provides root-level bounded retention defaults without retries', () => {
    const options = buildBoundedBullMqDefaultJobOptions();

    assert.deepStrictEqual(options, {
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    assert.equal('attempts' in options, false);
    assert.equal('backoff' in options, false);
  });

  it('uses bounded retention defaults without adding automatic retries', () => {
    const options = buildBoundedBullMqEnqueueOptions({ jobId: 'queue:job-1' });

    assert.deepStrictEqual(options, {
      jobId: 'queue:job-1',
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    assert.equal('attempts' in options, false);
    assert.equal('backoff' in options, false);
  });

  it('wires bounded retention defaults into the payments BullMQ root config', () => {
    const provider = getQueueBullRootProvider();
    const config = provider.useFactory({ url: 'redis://localhost:6379/0' }) as {
      readonly connection: { readonly url: string };
      readonly defaultJobOptions?: Record<string, unknown>;
    };

    assert.deepStrictEqual(provider.inject, [redisConfig.KEY]);
    assert.deepStrictEqual(config, {
      connection: { url: 'redis://localhost:6379/0' },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
    assert.equal('attempts' in (config.defaultJobOptions ?? {}), false);
    assert.equal('backoff' in (config.defaultJobOptions ?? {}), false);
  });

  it('keeps the shared bounded options usable for current payment reconciliation jobs', () => {
    assert.equal(PAYMENT_RECONCILIATION_JOB, 'reconcile-payment');
    assert.deepStrictEqual(buildBoundedBullMqEnqueueOptions({ jobId: 'reconcile:webhook:event-row-1' }), {
      jobId: 'reconcile:webhook:event-row-1',
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  });
});
