import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { HealthService } from '../src/modules/health/health.service';

interface PrismaProbe {
  $queryRawUnsafe: (query: string) => Promise<unknown>;
}

interface RedisClientProbe {
  ping: () => Promise<string>;
}

interface QueueProbe {
  readonly client: Promise<RedisClientProbe>;
  getJobCounts: () => Promise<{ waiting?: number; active?: number; failed?: number }>;
}

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
        client: {
          ping: async (): Promise<string> => {
            throw new Error(rawRedisFailure);
          },
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

function createQueueProbe(
  overrides: {
    client?: RedisClientProbe;
    counts?: { waiting?: number; active?: number; failed?: number };
    getJobCounts?: () => Promise<{ waiting?: number; active?: number; failed?: number }>;
  } = {},
): QueueProbe {
  return {
    client: Promise.resolve(
      overrides.client ?? {
        ping: async (): Promise<string> => 'PONG',
      },
    ),
    getJobCounts:
      overrides.getJobCounts ??
      (async () =>
        overrides.counts ?? {
          waiting: 0,
          active: 0,
          failed: 0,
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
