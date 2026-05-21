import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { databaseConfig } from '../src/common/config/database.config';
import { validateEnvironment } from '../src/common/config/env.schema';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { buildPrismaTransactionOptions, PrismaService } from '../src/common/prisma/prisma.service';

describe('PrismaService transaction options', () => {
  it('uses centrally validated database URL and transaction options', () => {
    const restoreEnvironment = setProcessEnvironment({
      ...createValidEnvironmentVariables(),
      DATABASE_URL: 'postgresql://rezeis:secret@db.internal:5432/rezeis',
      REZEIS_ADMIN_PRISMA_TRANSACTION_MAX_WAIT_MS: '2500',
      REZEIS_ADMIN_PRISMA_TRANSACTION_TIMEOUT_MS: '45000',
    });

    try {
      assert.deepStrictEqual(databaseConfig(), {
        url: 'postgresql://rezeis:secret@db.internal:5432/rezeis',
        transactionOptions: {
          maxWait: 2500,
          timeout: 45000,
        },
      });
    } finally {
      restoreEnvironment();
    }
  });

  it('fails through sanitized environment validation when database URL is missing', () => {
    const environment = createValidEnvironmentVariables();
    delete environment.DATABASE_URL;
    const restoreEnvironment = setProcessEnvironment(environment);

    try {
      assert.throws((): void => {
        databaseConfig();
      }, assertEnvironmentConfigurationError);
    } finally {
      restoreEnvironment();
    }
  });

  it('rejects malformed and unsupported database URLs without echoing raw credentials', () => {
    const unsafeDatabaseUrls = [
      'not-a-url',
      'http://db.internal:5432/rezeis',
      'postgresql://admin:secret-password@db.internal:5432/rezeis\u0000',
    ];

    for (const databaseUrl of unsafeDatabaseUrls) {
      assert.throws((): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          DATABASE_URL: databaseUrl,
        });
      }, assertEnvironmentConfigurationError);
    }

    try {
      validateEnvironment({
        ...createValidEnvironmentVariables(),
        DATABASE_URL: 'postgresql://admin:secret-password@db.internal:5432/rezeis\u0000',
      });
      assert.fail('Expected invalid database URL to be rejected');
    } catch (error) {
      assert.ok(error instanceof Error);
      const serializedError = JSON.stringify(error);
      assert.doesNotMatch(error.message, /secret-password/);
      assert.doesNotMatch(error.message, /postgresql:\/\/admin/);
      assert.doesNotMatch(serializedError, /secret-password/);
      assert.doesNotMatch(serializedError, /postgresql:\/\/admin/);
      assert.equal(error.stack, '');
    }
  });

  it('accepts trimmed Postgres database URLs from centralized validation', () => {
    const actualEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      DATABASE_URL: '  postgres://rezeis:secret@localhost:5432/rezeis  ',
    });

    assert.equal(actualEnvironment.DATABASE_URL, 'postgres://rezeis:secret@localhost:5432/rezeis');
  });

  it('builds bounded Prisma transaction defaults from validated configuration', () => {
    const transactionOptions = buildPrismaTransactionOptions({
      maxWait: 3500,
      timeout: 15000,
    });

    assert.deepStrictEqual(transactionOptions, {
      maxWait: 3500,
      timeout: 15000,
    });
  });

  it('passes transaction defaults into PrismaClient construction', () => {
    const service = new PrismaService({
      url: 'postgresql://rezeis:secret@localhost:5432/rezeis',
      transactionOptions: {
        maxWait: 4000,
        timeout: 20000,
      },
    });

    const engineConfiguration = service as unknown as {
      readonly _engineConfig?: {
        readonly transactionOptions?: {
          readonly maxWait?: number;
          readonly timeout?: number;
        };
      };
    };

    assert.equal(engineConfiguration._engineConfig?.transactionOptions?.maxWait, 4000);
    assert.equal(engineConfiguration._engineConfig?.transactionOptions?.timeout, 20000);
  });

  it('resolves PrismaService through Nest config injection with transaction defaults', async () => {
    const restoreEnvironment = setProcessEnvironment({
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_PRISMA_TRANSACTION_MAX_WAIT_MS: '7777',
      REZEIS_ADMIN_PRISMA_TRANSACTION_TIMEOUT_MS: '33333',
    });

    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            cache: false,
            ignoreEnvFile: true,
            load: [databaseConfig],
            validate: validateEnvironment,
          }),
          PrismaModule,
        ],
      }).compile();

      try {
        const service = moduleRef.get(PrismaService);
        const engineConfiguration = service as unknown as {
          readonly _engineConfig?: {
            readonly transactionOptions?: {
              readonly maxWait?: number;
              readonly timeout?: number;
            };
          };
        };

        assert.equal(engineConfiguration._engineConfig?.transactionOptions?.maxWait, 7777);
        assert.equal(engineConfiguration._engineConfig?.transactionOptions?.timeout, 33333);
      } finally {
        await moduleRef.close();
      }
    } finally {
      restoreEnvironment();
    }
  });

  it('validates optional transaction timeout environment variables', () => {
    const actualEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_PRISMA_TRANSACTION_MAX_WAIT_MS: '4500',
      REZEIS_ADMIN_PRISMA_TRANSACTION_TIMEOUT_MS: '25000',
    });

    assert.equal(actualEnvironment.REZEIS_ADMIN_PRISMA_TRANSACTION_MAX_WAIT_MS, 4500);
    assert.equal(actualEnvironment.REZEIS_ADMIN_PRISMA_TRANSACTION_TIMEOUT_MS, 25000);
  });

  it('rejects unsafe transaction timeout environment variables', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_PRISMA_TRANSACTION_MAX_WAIT_MS: '0',
        });
      },
      assertEnvironmentConfigurationError,
    );

    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_PRISMA_TRANSACTION_TIMEOUT_MS: '120001',
        });
      },
      assertEnvironmentConfigurationError,
    );
  });
});

function createValidEnvironmentVariables(): Record<string, unknown> {
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

function assertEnvironmentConfigurationError(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'EnvironmentConfigurationError');
  assert.match(error.message, /Environment configuration validation failed/);
  assert.equal(error.stack, '');
  return true;
}

function setProcessEnvironment(nextEnvironment: Record<string, unknown>): () => void {
  const previousValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(nextEnvironment)) {
    previousValues.set(key, process.env[key]);
    process.env[key] = String(value);
  }

  return (): void => {
    for (const [key, value] of previousValues) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }

      process.env[key] = value;
    }
  };
}
