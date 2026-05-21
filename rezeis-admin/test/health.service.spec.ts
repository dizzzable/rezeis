import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExternalDependencyReadinessService } from '../src/modules/health/external-dependency-readiness.service';
import { HealthService, runDatabaseReadinessProbeWithTimeout } from '../src/modules/health/health.service';
import { closeQueueProbesWithTimeout, QueueReadinessService, runQueueProbeCloseWithTimeout, runQueueReadinessProbeWithTimeout } from '../src/modules/health/queue-readiness.service';
import { QueueStatusService, runQueueStatusCountsWithTimeout } from '../src/modules/health/queue-status.service';

interface PrismaProbe {
  $queryRawUnsafe: (query: string) => Promise<unknown>;
}

interface HealthCheckRunner {
  check: (checks: Array<() => Promise<Record<string, { status: string }>>>) => Promise<unknown>;
}

const appConfiguration = {
  externalReadinessMode: 'disabled',
  serviceName: 'rezeis-admin',
};

const appConfigurationWithRemnawaveReadiness = {
  externalReadinessMode: 'remnawave',
  serviceName: 'rezeis-admin',
};

function createQueueReadinessService(
  checkQueues: () => Promise<Record<string, { readonly status: 'up' }>> = async () => ({}),
): QueueReadinessService {
  return {
    checkQueues,
    onModuleDestroy: async (): Promise<void> => undefined,
  } as QueueReadinessService;
}

function createExternalDependencyReadinessService(
  checkRemnawave: () => Promise<Record<string, { readonly status: 'up' }>> = async () => ({}),
): ExternalDependencyReadinessService {
  return {
    checkRemnawave,
  } as ExternalDependencyReadinessService;
}

describe('HealthService', () => {
  it('keeps the legacy health response db-aware without throwing on database failure', async () => {
    const prisma: PrismaProbe = {
      $queryRawUnsafe: async (query: string): Promise<unknown> => {
        assert.equal(query, 'SELECT 1');
        throw new Error('raw database password leak should stay internal');
      },
    };
    const healthCheckRunner: HealthCheckRunner = {
      check: async (): Promise<unknown> => ({ status: 'ok', info: {}, error: {}, details: {} }),
    };
    const service = new HealthService(
      prisma as never,
      healthCheckRunner as never,
      createQueueReadinessService(),
      createExternalDependencyReadinessService(),
      appConfiguration as never,
    );

    const response = await service.getHealth();

    assert.equal(response.status, 'error');
    assert.equal(response.service, 'rezeis-admin');
    assert.equal(response.database.status, 'down');
    assert.match(response.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('runs a Terminus-compatible readiness database probe', async () => {
    let probeCallsCount = 0;
    const prisma: PrismaProbe = {
      $queryRawUnsafe: async (query: string): Promise<unknown> => {
        probeCallsCount += 1;
        assert.equal(query, 'SELECT 1');
        return [{ ok: 1 }];
      },
    };
    const expectedReadiness = {
      status: 'ok',
      info: {
        database: {
          status: 'up',
        },
      },
      error: {},
      details: {
        database: {
          status: 'up',
        },
      },
    };
    const healthCheckRunner: HealthCheckRunner = {
      check: async (checks: Array<() => Promise<Record<string, { status: string }>>>): Promise<unknown> => {
        assert.equal(checks.length, 2);
        const databaseResult = await checks[0]();
        const queueResult = await checks[1]();
        assert.deepStrictEqual(databaseResult, {
          database: {
            status: 'up',
          },
        });
        assert.deepStrictEqual(queueResult, {
          paymentReconciliationQueue: {
            status: 'up',
          },
          profileSyncQueue: {
            status: 'up',
          },
        });
        return expectedReadiness;
      },
    };
    const service = new HealthService(
      prisma as never,
      healthCheckRunner as never,
      createQueueReadinessService(async () => ({
        paymentReconciliationQueue: {
          status: 'up',
        },
        profileSyncQueue: {
          status: 'up',
        },
      })),
      createExternalDependencyReadinessService(),
      appConfiguration as never,
    );

    const response = await service.getReadiness();

    assert.equal(probeCallsCount, 1);
    assert.deepStrictEqual(response, expectedReadiness);
  });

  it('adds bounded Remnawave readiness only when explicitly enabled', async () => {
    const prisma: PrismaProbe = {
      $queryRawUnsafe: async (): Promise<unknown> => [{ ok: 1 }],
    };
    const expectedReadiness = {
      status: 'ok',
      info: {
        database: {
          status: 'up',
        },
        remnawave: {
          status: 'up',
        },
      },
      error: {},
      details: {
        database: {
          status: 'up',
        },
        paymentReconciliationQueue: {
          status: 'up',
        },
        remnawave: {
          status: 'up',
        },
      },
    };
    const healthCheckRunner: HealthCheckRunner = {
      check: async (checks: Array<() => Promise<Record<string, { status: string }>>>): Promise<unknown> => {
        assert.equal(checks.length, 3);
        assert.deepStrictEqual(await checks[0](), {
          database: {
            status: 'up',
          },
        });
        assert.deepStrictEqual(await checks[1](), {
          paymentReconciliationQueue: {
            status: 'up',
          },
        });
        assert.deepStrictEqual(await checks[2](), {
          remnawave: {
            status: 'up',
          },
        });
        return expectedReadiness;
      },
    };
    const service = new HealthService(
      prisma as never,
      healthCheckRunner as never,
      createQueueReadinessService(async () => ({
        paymentReconciliationQueue: {
          status: 'up',
        },
      })),
      createExternalDependencyReadinessService(async () => ({
        remnawave: {
          status: 'up',
        },
      })),
      appConfigurationWithRemnawaveReadiness as never,
    );

    const response = await service.getReadiness();

    assert.deepStrictEqual(response, expectedReadiness);
  });

  it('sanitizes Remnawave readiness failures', async () => {
    const rawRemnawaveFailure = 'remnawave token leak https://remnawave.internal/profile?token=secret-token';
    const prisma: PrismaProbe = {
      $queryRawUnsafe: async (): Promise<unknown> => [{ ok: 1 }],
    };
    const healthCheckRunner: HealthCheckRunner = {
      check: async (checks: Array<() => Promise<Record<string, { status: string }>>>): Promise<unknown> => {
        assert.equal(checks.length, 3);
        try {
          await checks[2]();
        } catch (error) {
          const serializedError = JSON.stringify(error);

          assert.equal(error instanceof Error ? error.message : String(error), 'External dependency readiness check failed');
          assert.equal(serializedError.includes(rawRemnawaveFailure), false);
          assert.equal(serializedError.includes('secret-token'), false);
          assert.equal(serializedError.includes('https://remnawave.internal'), false);
          return {
            status: 'error',
            info: {
              database: {
                status: 'up',
              },
            },
            error: {
              remnawave: {
                status: 'down',
              },
            },
            details: {
              database: {
                status: 'up',
              },
              remnawave: {
                status: 'down',
              },
            },
          };
        }

        assert.fail('Expected sanitized Remnawave readiness failure');
      },
    };
    const service = new HealthService(
      prisma as never,
      healthCheckRunner as never,
      createQueueReadinessService(),
      createExternalDependencyReadinessService(async () => {
        throw new Error(rawRemnawaveFailure);
      }),
      appConfigurationWithRemnawaveReadiness as never,
    );

    const response = await service.getReadiness();

    assert.deepStrictEqual(response, {
      status: 'error',
      info: {
        database: {
          status: 'up',
        },
      },
      error: {
        remnawave: {
          status: 'down',
        },
      },
      details: {
        database: {
          status: 'up',
        },
        remnawave: {
          status: 'down',
        },
      },
    });
  });

  it('sanitizes readiness database failures before Terminus receives them', async () => {
    const rawDatabaseFailure = 'postgres://admin:secret-password@db.internal/rezeis stack trace';
    const prisma: PrismaProbe = {
      $queryRawUnsafe: async (query: string): Promise<unknown> => {
        assert.equal(query, 'SELECT 1');
        throw new Error(rawDatabaseFailure);
      },
    };
    const healthCheckRunner: HealthCheckRunner = {
      check: async (checks: Array<() => Promise<Record<string, { status: string }>>>): Promise<unknown> => {
        assert.equal(checks.length, 2);

        try {
          await checks[0]();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const serializedError = JSON.stringify(error);

          assert.equal(message, 'Database readiness check failed');
          assert.equal(serializedError.includes(rawDatabaseFailure), false);
          assert.equal(serializedError.includes('secret-password'), false);
          assert.equal(serializedError.includes('postgres://'), false);
          return {
            status: 'error',
            info: {},
            error: {
              database: {
                status: 'down',
              },
            },
            details: {
              database: {
                status: 'down',
              },
            },
          };
        }

        assert.fail('Expected sanitized readiness failure');
      },
    };
    const service = new HealthService(
      prisma as never,
      healthCheckRunner as never,
      createQueueReadinessService(),
      createExternalDependencyReadinessService(),
      appConfiguration as never,
    );

    const response = await service.getReadiness();

    assert.deepStrictEqual(response, {
      status: 'error',
      info: {},
      error: {
        database: {
          status: 'down',
        },
      },
      details: {
        database: {
          status: 'down',
        },
      },
    });
  });

  it('bounds stalled readiness database probes without exposing raw database details', async () => {
    const rawDatabaseFailure = 'postgres://admin:secret-password@db.internal/rezeis stalled query payload';
    const stalledProbe = new Promise<unknown>((resolve) => {
      setTimeout(() => {
        assert.equal(rawDatabaseFailure.includes('secret-password'), true);
        resolve([{ ok: 1 }]);
      }, 50);
    });

    await assert.rejects(
      runDatabaseReadinessProbeWithTimeout(() => stalledProbe, 5),
      (error: unknown): boolean => {
        assert.equal(error instanceof Error, true);
        const message = error instanceof Error ? error.message : String(error);
        const serialized = JSON.stringify(error);
        assert.equal(message, 'Database readiness probe timed out');
        assert.equal(serialized.includes(rawDatabaseFailure), false);
        assert.equal(serialized.includes('secret-password'), false);
        assert.equal(serialized.includes('postgres://'), false);
        assert.equal(serialized.includes('query payload'), false);
        return true;
      },
    );
  });

  it('sanitizes synchronous readiness database probe failures', async () => {
    const rawDatabaseFailure = 'postgres://admin:secret-password@db.internal/rezeis sync query payload';

    await assert.rejects(
      runDatabaseReadinessProbeWithTimeout((): Promise<unknown> => {
        throw new Error(rawDatabaseFailure);
      }, 5),
      (error: unknown): boolean => {
        assert.equal(error instanceof Error, true);
        const message = error instanceof Error ? error.message : String(error);
        const serialized = JSON.stringify(error);
        assert.equal(message, 'Database readiness probe failed');
        assert.equal(serialized.includes(rawDatabaseFailure), false);
        assert.equal(serialized.includes('secret-password'), false);
        assert.equal(serialized.includes('postgres://'), false);
        assert.equal(serialized.includes('query payload'), false);
        return true;
      },
    );
  });

  it('sanitizes readiness queue failures before Terminus receives them', async () => {
    const rawQueueFailure = 'redis://default:secret-password@redis.internal/0 job payload token';
    const prisma: PrismaProbe = {
      $queryRawUnsafe: async (query: string): Promise<unknown> => {
        assert.equal(query, 'SELECT 1');
        return [{ ok: 1 }];
      },
    };
    const healthCheckRunner: HealthCheckRunner = {
      check: async (checks: Array<() => Promise<Record<string, { status: string }>>>): Promise<unknown> => {
        assert.equal(checks.length, 2);
        await checks[0]();

        try {
          await checks[1]();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const serializedError = JSON.stringify(error);

          assert.equal(message, 'Queue readiness check failed');
          assert.equal(serializedError.includes(rawQueueFailure), false);
          assert.equal(serializedError.includes('secret-password'), false);
          assert.equal(serializedError.includes('redis://'), false);
          assert.equal(serializedError.includes('queues'), false);
          assert.equal(serializedError.includes('paymentReconciliationQueue'), true);
          assert.equal(serializedError.includes('profileSyncQueue'), true);
          assert.equal(serializedError.includes('notificationDeliveryQueue'), true);
          return {
            status: 'error',
            info: {
              database: {
                status: 'up',
              },
            },
            error: {
              paymentReconciliationQueue: {
                status: 'down',
              },
              profileSyncQueue: {
                status: 'down',
              },
              notificationDeliveryQueue: {
                status: 'down',
              },
            },
            details: {
              database: {
                status: 'up',
              },
              paymentReconciliationQueue: {
                status: 'down',
              },
              profileSyncQueue: {
                status: 'down',
              },
              notificationDeliveryQueue: {
                status: 'down',
              },
            },
          };
        }

        assert.fail('Expected sanitized queue readiness failure');
      },
    };
    const service = new HealthService(
      prisma as never,
      healthCheckRunner as never,
      createQueueReadinessService(async () => {
        throw new Error(rawQueueFailure);
      }),
      createExternalDependencyReadinessService(),
      appConfiguration as never,
    );

    const response = await service.getReadiness();

    assert.deepStrictEqual(response, {
      status: 'error',
      info: {
        database: {
          status: 'up',
        },
      },
      error: {
        paymentReconciliationQueue: {
          status: 'down',
        },
        profileSyncQueue: {
          status: 'down',
        },
        notificationDeliveryQueue: {
          status: 'down',
        },
      },
      details: {
        database: {
          status: 'up',
        },
        paymentReconciliationQueue: {
          status: 'down',
        },
        profileSyncQueue: {
          status: 'down',
        },
        notificationDeliveryQueue: {
          status: 'down',
        },
      },
    });
  });
});

describe('QueueReadinessService', () => {
  it('returns only safe aggregate labels for ready queues and closes probes', async () => {
    const closedLabels: string[] = [];
    const service = new QueueReadinessService({ url: 'redis://redis.internal/0' } as never, [
      {
        label: 'paymentReconciliationQueue',
        check: async (): Promise<void> => undefined,
        close: async (): Promise<void> => {
          closedLabels.push('paymentReconciliationQueue');
        },
      },
      {
        label: 'notificationDeliveryQueue',
        check: async (): Promise<void> => undefined,
        close: async (): Promise<void> => {
          closedLabels.push('notificationDeliveryQueue');
        },
      },
    ]);

    const response = await service.checkQueues();
    await service.onModuleDestroy();

    assert.deepStrictEqual(response, {
      paymentReconciliationQueue: {
        status: 'up',
      },
      notificationDeliveryQueue: {
        status: 'up',
      },
    });
    assert.deepStrictEqual(closedLabels.sort(), ['notificationDeliveryQueue', 'paymentReconciliationQueue']);
  });

  it('checks independent queue readiness probes concurrently while preserving response labels', async () => {
    let startedCount = 0;
    let resolveAllStarted: (() => void) | undefined;
    const allStarted = new Promise<void>((resolve) => {
      resolveAllStarted = resolve;
    });
    const startedLabels: string[] = [];

    function buildProbe(label: string) {
      return {
        label,
        check: async (): Promise<void> => {
          startedLabels.push(label);
          startedCount += 1;
          if (startedCount === 3) {
            resolveAllStarted?.();
          }
          await allStarted;
        },
        close: async (): Promise<void> => undefined,
      };
    }

    const service = new QueueReadinessService({ url: 'redis://redis.internal/0' } as never, [
      buildProbe('paymentReconciliationQueue'),
      buildProbe('profileSyncQueue'),
      buildProbe('notificationDeliveryQueue'),
    ]);

    const response = await service.checkQueues();

    assert.deepStrictEqual(startedLabels, [
      'paymentReconciliationQueue',
      'profileSyncQueue',
      'notificationDeliveryQueue',
    ]);
    assert.deepStrictEqual(response, {
      paymentReconciliationQueue: {
        status: 'up',
      },
      profileSyncQueue: {
        status: 'up',
      },
      notificationDeliveryQueue: {
        status: 'up',
      },
    });
  });

  it('throws sanitized aggregate queue failure details without raw queue errors', async () => {
    const rawQueueFailure = 'redis://default:secret-password@redis.internal/0 jobId=payment-event-raw';
    const service = new QueueReadinessService({ url: 'redis://redis.internal/0' } as never, [
      {
        label: 'paymentReconciliationQueue',
        check: async (): Promise<void> => {
          throw new Error(rawQueueFailure);
        },
        close: async (): Promise<void> => undefined,
      },
    ]);

    await assert.rejects(
      service.checkQueues(),
      (error: unknown): boolean => {
        assert.equal(error instanceof Error, true);
        const message = error instanceof Error ? error.message : String(error);
        const serialized = JSON.stringify(error);
        assert.equal(message, 'Queue readiness check failed');
        assert.equal(serialized.includes(rawQueueFailure), false);
        assert.equal(serialized.includes('secret-password'), false);
        assert.equal(serialized.includes('redis://'), false);
        assert.equal(serialized.includes('payment-event-raw'), false);
        assert.equal(serialized.includes('paymentReconciliationQueue'), true);
        return true;
      },
    );
  });

  it('bounds stalled queue readiness probes without exposing raw probe details', async () => {
    const rawQueueFailure = 'redis://default:secret-password@redis.internal/0 stalled job payload';
    const stalledProbe = new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(rawQueueFailure.includes('secret-password'), true);
        resolve();
      }, 50);
    });

    await assert.rejects(
      runQueueReadinessProbeWithTimeout(() => stalledProbe, 5),
      (error: unknown): boolean => {
        assert.equal(error instanceof Error, true);
        const message = error instanceof Error ? error.message : String(error);
        const serialized = JSON.stringify(error);
        assert.equal(message, 'Queue readiness probe timed out');
        assert.equal(serialized.includes(rawQueueFailure), false);
        assert.equal(serialized.includes('secret-password'), false);
        assert.equal(serialized.includes('redis://'), false);
        assert.equal(serialized.includes('job payload'), false);
        return true;
      },
    );
  });

  it('sanitizes synchronous queue readiness probe failures', async () => {
    const rawQueueFailure = 'redis://default:secret-password@redis.internal/0 sync readiness payload token';

    await assert.rejects(
      runQueueReadinessProbeWithTimeout(() => {
        throw new Error(rawQueueFailure);
      }, 5),
      (error: unknown): boolean => {
        assert.equal(error instanceof Error, true);
        const message = error instanceof Error ? error.message : String(error);
        const serialized = JSON.stringify(error);
        assert.equal(message, 'Queue readiness probe failed');
        assert.equal(serialized.includes(rawQueueFailure), false);
        assert.equal(serialized.includes('secret-password'), false);
        assert.equal(serialized.includes('redis://'), false);
        assert.equal(serialized.includes('payload token'), false);
        return true;
      },
    );
  });

  it('bounds stalled queue probe shutdown without surfacing raw close details', async () => {
    const rawQueueFailure = 'redis://default:secret-password@redis.internal/0 close payload token';
    const stalledClose = new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(rawQueueFailure.includes('secret-password'), true);
        resolve();
      }, 50);
    });

    const startedAt = Date.now();
    await runQueueProbeCloseWithTimeout(() => stalledClose, 5);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(rawQueueFailure.includes('redis://'), true);
    assert.equal(elapsedMs < 45, true);
  });

  it('swallows synchronous queue probe shutdown failures', async () => {
    const rawQueueFailure = 'redis://default:secret-password@redis.internal/0 sync close payload token';

    await runQueueProbeCloseWithTimeout(() => {
      throw new Error(rawQueueFailure);
    }, 5);

    assert.equal(rawQueueFailure.includes('secret-password'), true);
  });
});

describe('QueueStatusService', () => {
  it('returns only redacted queue count snapshots and closes probes', async () => {
    const rawSensitiveProbeDetails = 'redis://default:secret-password@redis.internal/0 jobId=payment-raw payload token';
    const closedLabels: string[] = [];
    const service = new QueueStatusService({ url: 'redis://redis.internal/0' } as never, [
      {
        label: 'paymentReconciliationQueue',
        getCounts: async () => {
          assert.equal(rawSensitiveProbeDetails.includes('payment-raw'), true);
          return {
            waiting: 2.9,
            active: 1,
            delayed: 0,
            completed: 11,
            failed: 3,
          };
        },
        close: async (): Promise<void> => {
          closedLabels.push('paymentReconciliationQueue');
        },
      },
      {
        label: 'notificationDeliveryQueue',
        getCounts: async () => ({
          waiting: -1,
          active: Number.NaN,
          delayed: undefined,
          completed: 4,
          failed: 0,
        }),
        close: async (): Promise<void> => {
          closedLabels.push('notificationDeliveryQueue');
        },
      },
    ]);

    const snapshot = await service.getSnapshot();
    await service.onModuleDestroy();
    const serialized = JSON.stringify(snapshot);

    assert.match(snapshot.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepStrictEqual(snapshot.queues, [
      {
        label: 'paymentReconciliationQueue',
        counts: {
          waiting: 2,
          active: 1,
          delayed: 0,
          completed: 11,
          failed: 3,
        },
      },
      {
        label: 'notificationDeliveryQueue',
        counts: {
          waiting: 0,
          active: 0,
          delayed: 0,
          completed: 4,
          failed: 0,
        },
      },
    ]);
    assert.deepStrictEqual(closedLabels.sort(), ['notificationDeliveryQueue', 'paymentReconciliationQueue']);
    assert.equal(serialized.includes(rawSensitiveProbeDetails), false);
    assert.equal(serialized.includes('secret-password'), false);
    assert.equal(serialized.includes('redis://'), false);
    assert.equal(serialized.includes('jobId'), false);
    assert.equal(serialized.includes('payload'), false);
    assert.equal(serialized.includes('payment-raw'), false);
  });

  it('bounds stalled queue status-shaped probe shutdown without leaking close internals', async () => {
    const rawSensitiveProbeDetails = 'redis://default:secret-password@redis.internal/0 status close payload token';
    let closeStarted = false;
    const probes = [
      {
        label: 'paymentReconciliationQueue',
        getCounts: async () => ({}),
        close: async (): Promise<void> => {
          closeStarted = true;
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              assert.equal(rawSensitiveProbeDetails.includes('status close payload'), true);
              resolve();
            }, 50);
          });
        },
      },
    ];

    const startedAt = Date.now();
    await closeQueueProbesWithTimeout(probes, 5);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(closeStarted, true);
    assert.equal(elapsedMs < 45, true);
  });

  it('bounds stalled queue status count probes without leaking Redis details', async () => {
    const rawSensitiveProbeDetails = 'redis://default:secret-password@redis.internal/0 status count payload token';
    const stalledCounts = new Promise<{ waiting: number }>((resolve) => {
      setTimeout(() => {
        assert.equal(rawSensitiveProbeDetails.includes('secret-password'), true);
        resolve({ waiting: 99 });
      }, 50);
    });

    const startedAt = Date.now();
    const counts = await runQueueStatusCountsWithTimeout(() => stalledCounts, 5);
    const elapsedMs = Date.now() - startedAt;
    const serialized = JSON.stringify(counts);

    assert.deepStrictEqual(counts, {});
    assert.equal(elapsedMs < 45, true);
    assert.equal(serialized.includes(rawSensitiveProbeDetails), false);
    assert.equal(serialized.includes('secret-password'), false);
    assert.equal(serialized.includes('redis://'), false);
    assert.equal(serialized.includes('payload token'), false);
  });

  it('returns empty queue status counts when count probes throw synchronously', async () => {
    const rawSensitiveProbeDetails = 'redis://default:secret-password@redis.internal/0 sync status count payload token';

    const counts = await runQueueStatusCountsWithTimeout(() => {
      throw new Error(rawSensitiveProbeDetails);
    }, 5);
    const serialized = JSON.stringify(counts);

    assert.deepStrictEqual(counts, {});
    assert.equal(serialized.includes(rawSensitiveProbeDetails), false);
    assert.equal(serialized.includes('secret-password'), false);
    assert.equal(serialized.includes('redis://'), false);
    assert.equal(serialized.includes('payload token'), false);
  });

  it('returns zeroed queue status counts when a count probe fails', async () => {
    const rawSensitiveProbeDetails = 'redis://default:secret-password@redis.internal/0 failed count payload token';
    const service = new QueueStatusService({ url: 'redis://redis.internal/0' } as never, [
      {
        label: 'paymentReconciliationQueue',
        getCounts: async () => {
          throw new Error(rawSensitiveProbeDetails);
        },
        close: async (): Promise<void> => undefined,
      },
    ]);

    const snapshot = await service.getSnapshot();
    const serialized = JSON.stringify(snapshot);

    assert.deepStrictEqual(snapshot.queues, [
      {
        label: 'paymentReconciliationQueue',
        counts: {
          waiting: 0,
          active: 0,
          delayed: 0,
          completed: 0,
          failed: 0,
        },
      },
    ]);
    assert.equal(serialized.includes(rawSensitiveProbeDetails), false);
    assert.equal(serialized.includes('secret-password'), false);
    assert.equal(serialized.includes('redis://'), false);
    assert.equal(serialized.includes('payload token'), false);
  });

  it('runs queue status count probes concurrently while preserving response order', async () => {
    let startedCount = 0;
    let resolveAllStarted: (() => void) | undefined;
    const allStarted = new Promise<void>((resolve) => {
      resolveAllStarted = resolve;
    });
    const probes = ['paymentReconciliationQueue', 'profileSyncQueue', 'notificationDeliveryQueue'].map(
      (label, index) => ({
        label,
        getCounts: async () => {
          startedCount += 1;
          if (startedCount === 3) {
            resolveAllStarted?.();
          }
          await allStarted;
          return { waiting: index + 1 };
        },
        close: async (): Promise<void> => undefined,
      }),
    );
    const service = new QueueStatusService({ url: 'redis://redis.internal/0' } as never, probes);

    const startedAt = Date.now();
    const snapshot = await service.getSnapshot();
    const elapsedMs = Date.now() - startedAt;

    assert.equal(elapsedMs < 100, true);
    assert.deepStrictEqual(
      snapshot.queues.map((queue) => ({ label: queue.label, waiting: queue.counts.waiting })),
      [
        { label: 'paymentReconciliationQueue', waiting: 1 },
        { label: 'profileSyncQueue', waiting: 2 },
        { label: 'notificationDeliveryQueue', waiting: 3 },
      ],
    );
  });
});
