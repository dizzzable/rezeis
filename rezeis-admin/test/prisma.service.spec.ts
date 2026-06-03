import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Test } from '@nestjs/testing';

import { databaseConfig } from '../src/common/config/database.config';
import { buildDatabaseUrl, validateEnvironment } from '../src/common/config/env.schema';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

describe('PrismaService database configuration', () => {
  it('validates split database settings and builds the canonical URL', () => {
    const environment = validateEnvironment({
      REZEIS_CRYPT_KEY: 'crypt-key',
      DATABASE_HOST: 'db.internal',
      DATABASE_PORT: '6543',
      DATABASE_NAME: 'rezeis_prod',
      DATABASE_USER: 'rezeis_user',
      DATABASE_PASSWORD: 'p@ ss',
    });

    assert.equal(environment.DATABASE_HOST, 'db.internal');
    assert.equal(environment.DATABASE_PORT, 6543);
    assert.equal(environment.DATABASE_NAME, 'rezeis_prod');
    assert.equal(environment.DATABASE_USER, 'rezeis_user');
    assert.equal(environment.DATABASE_PASSWORD, 'p@ ss');
    assert.equal(buildDatabaseUrl(environment), 'postgresql://rezeis_user:p%40%20ss@db.internal:6543/rezeis_prod');
  });

  it('exposes databaseConfig from split DATABASE_* variables', async () => {
    await withDatabaseEnvironment(
      {
        DATABASE_URL: undefined,
        DATABASE_HOST: 'postgres.internal',
        DATABASE_PORT: '6543',
        DATABASE_NAME: 'rezeis_admin',
        DATABASE_USER: 'admin_user',
        DATABASE_PASSWORD: 'secret value',
        DATABASE_POOL_SIZE: '12',
        DATABASE_MAX_OVERFLOW: '4',
        DATABASE_POOL_TIMEOUT: '7',
        DATABASE_POOL_RECYCLE: '900',
      },
      () => {
        assert.deepStrictEqual(databaseConfig(), {
          host: 'postgres.internal',
          port: 6543,
          name: 'rezeis_admin',
          user: 'admin_user',
          password: 'secret value',
          url: 'postgresql://admin_user:secret%20value@postgres.internal:6543/rezeis_admin',
          poolSize: 12,
          maxOverflow: 4,
          poolTimeout: 7,
          poolRecycle: 900,
        });
      },
    );
  });

  it('passes an explicit DATABASE_URL override into Prisma 7 adapter construction', async () => {
    await withDatabaseEnvironment(
      {
        DATABASE_URL: 'postgresql://override:secret@override.internal:5432/rezeis',
        DATABASE_HOST: 'ignored.internal',
        DATABASE_PORT: '6543',
        DATABASE_NAME: 'ignored',
        DATABASE_USER: 'ignored',
        DATABASE_PASSWORD: 'ignored',
      },
      () => {
        const service = new PrismaService();

        assert.equal(
          readPrismaConnectionString(service),
          'postgresql://override:secret@override.internal:5432/rezeis',
        );
      },
    );
  });

  it('falls back to split DATABASE_* variables when DATABASE_URL is absent', async () => {
    await withDatabaseEnvironment(
      {
        DATABASE_URL: undefined,
        DATABASE_HOST: 'db.internal',
        DATABASE_PORT: '6543',
        DATABASE_NAME: 'rezeis_prod',
        DATABASE_USER: 'rezeis_user',
        DATABASE_PASSWORD: 'p@ ss',
      },
      () => {
        const service = new PrismaService();

        assert.equal(
          readPrismaConnectionString(service),
          'postgresql://rezeis_user:p%40%20ss@db.internal:6543/rezeis_prod',
        );
      },
    );
  });

  it('registers PrismaService as a no-argument Nest provider', async () => {
    await withDatabaseEnvironment(
      {
        DATABASE_URL: undefined,
        DATABASE_HOST: 'db.internal',
        DATABASE_PORT: '5432',
        DATABASE_NAME: 'rezeis',
        DATABASE_USER: 'rezeis',
        DATABASE_PASSWORD: 'secret',
      },
      async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [PrismaModule],
        }).compile();

        try {
          const service = moduleRef.get(PrismaService);

          assert.equal(typeof service.onModuleInit, 'function');
          assert.equal(typeof service.onModuleDestroy, 'function');
          assert.equal(readPrismaConnectionString(service), 'postgresql://rezeis:secret@db.internal:5432/rezeis');
        } finally {
          await moduleRef.close();
        }
      },
    );
  });
});

function readPrismaConnectionString(service: PrismaService): string | undefined {
  const engineConfiguration = service as unknown as {
    readonly _engineConfig?: {
      readonly adapter?: {
        readonly config?: {
          readonly connectionString?: string;
        };
      };
    };
  };

  return engineConfiguration._engineConfig?.adapter?.config?.connectionString;
}

async function withDatabaseEnvironment<T>(
  nextValues: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previousValues = new Map<string, string | undefined>();

  for (const key of Object.keys(nextValues)) {
    previousValues.set(key, process.env[key]);
    const nextValue = nextValues[key];
    if (nextValue === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = nextValue;
  }

  try {
    return await fn();
  } finally {
    for (const [key, previousValue] of previousValues) {
      if (previousValue === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = previousValue;
    }
  }
}
