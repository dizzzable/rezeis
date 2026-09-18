import 'reflect-metadata';

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { after, describe, it, type TestContext } from 'node:test';

import { createIORedisClient, type Queue } from 'bullmq';
import { Redis, type Command } from 'ioredis';

import { HealthService } from '../src/modules/health/health.service';

interface PrismaProbe {
  $queryRawUnsafe: (query: string) => Promise<unknown>;
}

/**
 * The queue, as far as HealthService reaches, typed from bullmq's own `Queue`:
 * a change of shape there — bullmq 6 has no `Queue#client` — stops this
 * compiling instead of leaving the fake to answer for a library that no longer
 * does. `client` resolves to what 5.81.5 resolves it to (see `queueProbe`).
 */
type QueueProbe = Pick<Queue, 'client' | 'getJobCounts'>;

/** `getJobCounts()` on 5.81.5, asked for no type in particular: every type. */
const EVERY_JOB_COUNT = {
  active: 0,
  completed: 0,
  delayed: 0,
  failed: 0,
  paused: 0,
  prioritized: 0,
  waiting: 0,
  'waiting-children': 0,
};

const originalBackupLocation = process.env.BACKUP_LOCATION;
const originalAppVersion = process.env.APP_VERSION;
const originalGitSha = process.env.REZEIS_GIT_SHA;
const originalPackageVersion = process.env.npm_package_version;

after(() => {
  restoreProcessEnv('BACKUP_LOCATION', originalBackupLocation);
  restoreProcessEnv('APP_VERSION', originalAppVersion);
  restoreProcessEnv('REZEIS_GIT_SHA', originalGitSha);
  restoreProcessEnv('npm_package_version', originalPackageVersion);
});

describe('HealthService', () => {
  it('returns ok when all current probes succeed', async () => {
    process.env.BACKUP_LOCATION = process.cwd();
    process.env.APP_VERSION = '0.7.3-test';
    process.env.REZEIS_GIT_SHA = '0123456789abcdef0123456789abcdef01234567';
    process.env.npm_package_version = '0.7.3-test';
    const service = createService();

    const response = await service.getHealth();

    assert.equal(response.status, 'ok');
    assert.equal(response.service, 'rezeis-admin');
    assert.equal(response.version, '0.7.3-test');
    assert.equal(response.gitSha, '0123456789abcdef0123456789abcdef01234567');
    assert.match(response.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(Number.isInteger(response.uptime), true);
    assert.equal(response.components.database.status, 'up');
    assert.equal(response.components.redis.status, 'up');
    assert.equal(response.components.queues.status, 'up');
    assert.equal(response.components.disk.status, 'up');
  });

  it('falls back to package version and hides unknown git metadata', async () => {
    process.env.BACKUP_LOCATION = process.cwd();
    delete process.env.APP_VERSION;
    process.env.REZEIS_GIT_SHA = 'unknown';
    process.env.npm_package_version = '0.7.3-package';
    const service = createService();

    const response = await service.getHealth();

    assert.equal(response.version, '0.7.3-package');
    assert.equal(response.gitSha, null);
  });

  it('marks database failures as critical without exposing raw connection diagnostics', async () => {
    process.env.BACKUP_LOCATION = process.cwd();
    const rawDatabaseFailure = 'postgres://admin:secret-password@db.internal/rezeis?token=provider-secret-token';
    const service = createService({
      prisma: {
        $queryRawUnsafe: async (query: string): Promise<unknown> => {
          assert.equal(query, 'SELECT 1');
          throw new Error(rawDatabaseFailure);
        },
      },
    });

    const response = await service.getHealth();
    const serialized = JSON.stringify(response);

    assert.equal(response.status, 'error');
    assert.equal(response.components.database.status, 'down');
    assert.equal(response.components.database.details, 'database_unavailable');
    assert.equal(serialized.includes(rawDatabaseFailure), false);
    assert.equal(serialized.includes('secret-password'), false);
    assert.equal(serialized.includes('provider-secret-token'), false);
    assert.equal(serialized.includes('postgres://'), false);
  });

  it('marks Redis failures as critical without exposing raw connection diagnostics', async () => {
    process.env.BACKUP_LOCATION = process.cwd();
    const rawRedisFailure = 'redis://default:secret-password@redis.internal/0 token=raw-token';
    const service = createService({
      queue: createQueueProbe({
        ping: async (): Promise<string> => {
          throw new Error(rawRedisFailure);
        },
      }),
    });

    const response = await service.getHealth();
    const serialized = JSON.stringify(response);

    assert.equal(response.status, 'error');
    assert.equal(response.components.redis.status, 'down');
    assert.equal(response.components.redis.details, 'redis_unavailable');
    assert.equal(serialized.includes(rawRedisFailure), false);
    assert.equal(serialized.includes('secret-password'), false);
    assert.equal(serialized.includes('raw-token'), false);
    assert.equal(serialized.includes('redis://'), false);
  });

  it('marks stalled-looking queues as degraded while preserving bounded queue counts', async () => {
    process.env.BACKUP_LOCATION = process.cwd();
    const service = createService({
      queue: createQueueProbe({ counts: { waiting: 4, active: 50, failed: 2 } }),
    });

    const response = await service.getHealth();

    assert.equal(response.status, 'degraded');
    assert.deepStrictEqual(response.components.queues, {
      status: 'down',
      details: 'waiting=4 active=50 failed=2',
    });
  });

  it('marks queue probe errors as degraded without exposing raw Redis diagnostics', async () => {
    process.env.BACKUP_LOCATION = process.cwd();
    const rawQueueFailure = 'redis://default:secret-password@redis.internal/0 job payload token=raw-token';
    const service = createService({
      queue: createQueueProbe({
        getJobCounts: async () => {
          throw new Error(rawQueueFailure);
        },
      }),
    });

    const response = await service.getHealth();
    const serialized = JSON.stringify(response);

    assert.equal(response.status, 'degraded');
    assert.equal(response.components.queues.status, 'down');
    assert.equal(response.components.queues.details, 'queue_unavailable');
    assert.equal(serialized.includes(rawQueueFailure), false);
    assert.equal(serialized.includes('secret-password'), false);
    assert.equal(serialized.includes('raw-token'), false);
    assert.equal(serialized.includes('redis://'), false);
  });

  it('marks disk write failures as degraded without exposing local paths', async () => {
    process.env.BACKUP_LOCATION = 'V:/REZEIS_ADMIN_RUID_USER/rezeis/rezeis-admin/path-that-does-not-exist';
    const service = createService();

    const response = await service.getHealth();
    const serialized = JSON.stringify(response);

    assert.equal(response.status, 'degraded');
    assert.equal(response.components.disk.status, 'down');
    assert.equal(response.components.disk.details, 'disk_unavailable');
    assert.equal(serialized.includes('path-that-does-not-exist'), false);
    assert.equal(serialized.includes('REZEIS_ADMIN_RUID_USER'), false);
  });
});

/**
 * A dependency that stops answering is reported down, and the answer comes
 * inside the compose healthcheck's budget: docker kills the probe's `wget`
 * after 5 s (e2e, demo) or 10 s (production).
 *
 * A paused Valkey keeps its TCP connection open and never replies, and ioredis
 * has no command timeout of its own, so a PING sent to it — and `getJobCounts`
 * on the same connection — stays pending. Without a bound of its own the
 * endpoint therefore hung instead of saying Redis was down.
 *
 * `setTimeout` is mocked, so the 3 s pass exactly and in no time. Each case
 * checks both edges: nothing has answered at 2 999 ms, and the answer is there
 * at 3 000 ms — a budget that is shorter, longer or missing fails one of them.
 */
describe('a stalled dependency is reported down within the probe budget', () => {
  it('reports Redis down at 3 s when PING never answers', async (t) => {
    process.env.BACKUP_LOCATION = process.cwd();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    answerDiskAtOnce(t);
    const service = createService({ queue: createQueueProbe({ ping: never }) });

    const response = await healthAtTheBudget(t, service);

    assert.equal(response.status, 'error');
    assert.equal(response.components.redis.status, 'down');
    assert.equal(response.components.redis.details, 'redis_unavailable');
    // Control: only the stalled probe is down.
    assert.equal(response.components.database.status, 'up');
    assert.equal(response.components.queues.status, 'up');
    assert.equal(response.components.disk.status, 'up');
  });

  it('reports Redis and the queues down at 3 s when the whole connection stalls, as a paused Valkey does', async (t) => {
    process.env.BACKUP_LOCATION = process.cwd();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    answerDiskAtOnce(t);
    const service = createService({ queue: createQueueProbe({ ping: never, getJobCounts: never }) });

    const response = await healthAtTheBudget(t, service);

    assert.equal(response.status, 'error');
    assert.equal(response.components.redis.status, 'down');
    assert.deepStrictEqual(response.components.queues, { status: 'down', details: 'queue_unavailable' });
    assert.equal(response.components.database.status, 'up');
    assert.equal(response.components.disk.status, 'up');
  });

  it('reports the database down at 3 s when SELECT 1 never answers', async (t) => {
    process.env.BACKUP_LOCATION = process.cwd();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    answerDiskAtOnce(t);
    const service = createService({ prisma: { $queryRawUnsafe: never } });

    const response = await healthAtTheBudget(t, service);

    assert.equal(response.status, 'error');
    assert.equal(response.components.database.status, 'down');
    assert.equal(response.components.database.details, 'database_unavailable');
    assert.equal(response.components.redis.status, 'up');
  });

  it('reports the backup volume down at 3 s when the write never returns', async (t) => {
    process.env.BACKUP_LOCATION = process.cwd();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(fsp, 'writeFile', never);
    const service = createService();

    const response = await healthAtTheBudget(t, service);

    assert.equal(response.status, 'degraded');
    assert.deepStrictEqual(response.components.disk, { status: 'down', details: 'disk_unavailable' });
    assert.equal(response.components.redis.status, 'up');
  });

  it('leaves no timer armed once every probe has answered', async () => {
    process.env.BACKUP_LOCATION = process.cwd();
    const service = createService();
    const armedBefore = armedTimeouts();

    const response = await service.getHealth();

    assert.equal(response.status, 'ok');
    assert.equal(
      armedTimeouts(),
      armedBefore,
      'a probe that answered left its 3 s timer running — one per request, for every healthcheck',
    );
  });
});

/** A promise that never settles: a dependency that has stopped answering. */
function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/**
 * The backup-volume probe answering at once. Under a mocked clock the real
 * write would race the tick that expires every probe, so the cases about other
 * components hold the disk still instead.
 */
function answerDiskAtOnce(t: TestContext): void {
  t.mock.method(fsp, 'writeFile', async () => undefined);
  t.mock.method(fsp, 'unlink', async () => undefined);
}

/** Lets pending I/O callbacks and microtasks run; `setImmediate` is not mocked. */
async function flushIo(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * `getHealth()` under the mocked clock: asserts nothing has answered at
 * 2 999 ms and the answer is there at 3 000 ms, then returns it. Settlement is
 * observed, never awaited blind, so a probe with no bound fails the second
 * assertion instead of hanging the run.
 */
async function healthAtTheBudget(
  t: TestContext,
  service: HealthService,
): Promise<Awaited<ReturnType<HealthService['getHealth']>>> {
  let settled = false;
  const pending = service.getHealth().then((response) => {
    settled = true;
    return response;
  });
  await flushIo();
  t.mock.timers.tick(2_999);
  await flushIo();
  assert.equal(settled, false, 'answered before 3 s: the stalled probe did not stall, or its budget is shorter');
  t.mock.timers.tick(1);
  await flushIo();
  assert.equal(settled, true, 'still waiting on a stalled dependency after 3 s: the probe has no budget');
  return pending;
}

function armedTimeouts(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

function createService(overrides: { prisma?: PrismaProbe; queue?: QueueProbe } = {}): HealthService {
  const prisma = overrides.prisma ?? {
    $queryRawUnsafe: async (query: string): Promise<unknown> => {
      assert.equal(query, 'SELECT 1');
      return [{ ok: 1 }];
    },
  };
  const queue = overrides.queue ?? createQueueProbe();

  return new HealthService(
    prisma as never,
    { serviceName: 'rezeis-admin' } as never,
    { url: 'redis://redis.internal/0' } as never,
    queue as never,
  );
}

/**
 * `client` resolves to what bullmq 5.81.5 resolves it to: BullMQ's Proxy
 * (`createIORedisClient`) over an ioredis client. PING is answered where the
 * socket would be — ioredis's `sendCommand` — so the path HealthService takes in
 * production, the Proxy forwarding PING to ioredis, is the path it takes here.
 */
function createQueueProbe(
  overrides: {
    ping?: () => Promise<string>;
    counts?: Partial<typeof EVERY_JOB_COUNT>;
    getJobCounts?: QueueProbe['getJobCounts'];
  } = {},
): QueueProbe {
  const answer = overrides.ping ?? (async (): Promise<string> => 'PONG');
  const redis = new Redis({ lazyConnect: true, enableOfflineQueue: false, retryStrategy: () => null });
  redis.sendCommand = (command: Command): Promise<unknown> => {
    if (command.name.toLowerCase() === 'ping') {
      answer().then(command.resolve, command.reject);
    } else {
      command.reject(new Error(`HealthService sent ${command.name}, which nothing here answers`));
    }
    return command.promise;
  };
  return {
    client: Promise.resolve(createIORedisClient(redis)),
    getJobCounts:
      overrides.getJobCounts ??
      (async (...types: unknown[]) => {
        assert.deepStrictEqual(types, [], 'HealthService reads the counts of every type');
        return { ...EVERY_JOB_COUNT, ...overrides.counts };
      }),
  };
}

function restoreProcessEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
