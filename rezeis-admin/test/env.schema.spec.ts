import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appConfig } from '../src/common/config/app.config';
import { validateEnvironment } from '../src/common/config/env.schema';

describe('validateEnvironment', () => {
  it('parses the SMTP delivery variables into the expected runtime shapes', () => {
    const actualEnvironment = validateEnvironment(createValidEnvironmentVariables());
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_HOST, 'smtp.example.com');
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_PORT, 465);
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_SECURE, true);
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_REPLY_TO, 'support@example.com');
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_TIMEOUT_MS, 10000);
    assert.equal(actualEnvironment.REZEIS_ADMIN_METRICS_ACCESS_MODE, 'open');
    assert.equal(actualEnvironment.REZEIS_ADMIN_TRUST_PROXY, 'disabled');
  });

  it('accepts basic-auth protected metrics mode when both credentials are provided', () => {
    const actualEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_METRICS_ACCESS_MODE: 'basic',
      REZEIS_ADMIN_METRICS_BASIC_USER: 'prometheus',
      REZEIS_ADMIN_METRICS_BASIC_PASSWORD: 'metrics-password',
    });

    assert.equal(actualEnvironment.REZEIS_ADMIN_METRICS_ACCESS_MODE, 'basic');
    assert.equal(actualEnvironment.REZEIS_ADMIN_METRICS_BASIC_USER, 'prometheus');
    assert.equal(actualEnvironment.REZEIS_ADMIN_METRICS_BASIC_PASSWORD, 'metrics-password');
  });

  it('normalizes and accepts Redis and Redis TLS URLs', () => {
    const redisEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      REDIS_URL: '  redis://localhost:6379/1  ',
    });
    const redissEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      REDIS_URL: 'rediss://cache.example.com:6380/0',
    });

    assert.equal(redisEnvironment.REDIS_URL, 'redis://localhost:6379/1');
    assert.equal(redissEnvironment.REDIS_URL, 'rediss://cache.example.com:6380/0');
  });

  it('normalizes a comma-separated CORS origin allowlist', () => {
    const actualEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_CORS_ORIGIN: ' https://admin.example.com , https://ops.example.com:8443 , https://admin.example.com ',
    });

    assert.deepEqual(actualEnvironment.REZEIS_ADMIN_CORS_ORIGIN, [
      'https://admin.example.com',
      'https://ops.example.com:8443',
    ]);
  });

  it('provides the validated normalized CORS origins to app config', () => {
    const previousEnvironment = process.env;
    process.env = {
      ...previousEnvironment,
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_CORS_ORIGIN: ' https://admin.example.com , https://admin.example.com , https://ops.example.com ',
    } as NodeJS.ProcessEnv;

    try {
      assert.deepEqual(appConfig(), {
        corsOrigin: ['https://admin.example.com', 'https://ops.example.com'],
        docsEnabled: true,
        externalReadinessMode: 'disabled',
        nodeEnv: 'test',
        port: 3000,
        serviceName: 'rezeis-admin',
        trustProxy: 'disabled',
      });
    } finally {
      process.env = previousEnvironment;
    }
  });

  it('keeps API docs enabled by default outside production and disabled by default in production', () => {
    const developmentEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      NODE_ENV: 'development',
    });
    const productionEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      NODE_ENV: 'production',
    });

    assert.equal(developmentEnvironment.REZEIS_ADMIN_DOCS_ENABLED, undefined);
    assert.equal(productionEnvironment.REZEIS_ADMIN_DOCS_ENABLED, undefined);

    const previousEnvironment = process.env;
    try {
      process.env = {
        ...previousEnvironment,
        ...createValidEnvironmentVariables(),
        NODE_ENV: 'development',
      } as NodeJS.ProcessEnv;
      assert.equal(appConfig().docsEnabled, true);

      process.env = {
        ...previousEnvironment,
        ...createValidEnvironmentVariables(),
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv;
      assert.equal(appConfig().docsEnabled, false);
    } finally {
      process.env = previousEnvironment;
    }
  });

  it('allows explicit API docs exposure overrides through validated environment config', () => {
    const disabledEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      NODE_ENV: 'development',
      REZEIS_ADMIN_DOCS_ENABLED: 'false',
    });
    const enabledEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      NODE_ENV: 'production',
      REZEIS_ADMIN_DOCS_ENABLED: 'true',
    });

    assert.equal(disabledEnvironment.REZEIS_ADMIN_DOCS_ENABLED, false);
    assert.equal(enabledEnvironment.REZEIS_ADMIN_DOCS_ENABLED, true);

    const previousEnvironment = process.env;
    try {
      process.env = {
        ...previousEnvironment,
        ...createValidEnvironmentVariables(),
        NODE_ENV: 'development',
        REZEIS_ADMIN_DOCS_ENABLED: 'false',
      } as NodeJS.ProcessEnv;
      assert.equal(appConfig().docsEnabled, false);

      process.env = {
        ...previousEnvironment,
        ...createValidEnvironmentVariables(),
        NODE_ENV: 'production',
        REZEIS_ADMIN_DOCS_ENABLED: 'true',
      } as NodeJS.ProcessEnv;
      assert.equal(appConfig().docsEnabled, true);
    } finally {
      process.env = previousEnvironment;
    }
  });

  it('rejects invalid API docs exposure values', () => {
    for (const docsEnabled of ['yes', '1', 'enabled', 'TRUE']) {
      assert.throws(
        (): void => {
          validateEnvironment({
            ...createValidEnvironmentVariables(),
            REZEIS_ADMIN_DOCS_ENABLED: docsEnabled,
          });
        },
        assertEnvironmentConfigurationError,
      );
    }
  });

  it('allows only bounded named trusted proxy modes and exposes them through app config', () => {
    for (const trustProxy of ['loopback', 'linklocal', 'uniquelocal'] as const) {
      const actualEnvironment = validateEnvironment({
        ...createValidEnvironmentVariables(),
        REZEIS_ADMIN_TRUST_PROXY: trustProxy,
      });
      assert.equal(actualEnvironment.REZEIS_ADMIN_TRUST_PROXY, trustProxy);
    }

    const previousEnvironment = process.env;
    process.env = {
      ...previousEnvironment,
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_TRUST_PROXY: 'loopback',
    } as NodeJS.ProcessEnv;

    try {
      assert.equal(appConfig().trustProxy, 'loopback');
    } finally {
      process.env = previousEnvironment;
    }
  });

  it('rejects unsafe trusted proxy configuration values without echoing raw header-like input', () => {
    for (const trustProxy of [
      'true',
      '1',
      '*',
      '10.0.0.0/8',
      'x-forwarded-for: 203.0.113.10',
      'loopback,uniquelocal',
    ]) {
      assert.throws(
        (): void => {
          validateEnvironment({
            ...createValidEnvironmentVariables(),
            REZEIS_ADMIN_TRUST_PROXY: trustProxy,
          });
        },
        (error: unknown): boolean => {
          assertEnvironmentConfigurationError(error);
          const message = error instanceof Error ? error.message : '';
          assert.match(message, /REZEIS_ADMIN_TRUST_PROXY/);
          assert.doesNotMatch(message, /203\.0\.113\.10/);
          assert.doesNotMatch(message, /x-forwarded-for/i);
          assert.doesNotMatch(message, /10\.0\.0\.0/);
          return true;
        },
      );
    }
  });

  it('allows only bounded external readiness modes and exposes them through app config', () => {
    const disabledEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
    });
    const remnawaveEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_EXTERNAL_READINESS_MODE: 'remnawave',
    });

    assert.equal(disabledEnvironment.REZEIS_ADMIN_EXTERNAL_READINESS_MODE, 'disabled');
    assert.equal(remnawaveEnvironment.REZEIS_ADMIN_EXTERNAL_READINESS_MODE, 'remnawave');

    const previousEnvironment = process.env;
    process.env = {
      ...previousEnvironment,
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_EXTERNAL_READINESS_MODE: 'remnawave',
    } as NodeJS.ProcessEnv;

    try {
      assert.equal(appConfig().externalReadinessMode, 'remnawave');
    } finally {
      process.env = previousEnvironment;
    }
  });

  it('rejects unsafe external readiness mode values without echoing secret-like input', () => {
    for (const externalReadinessMode of ['enabled', 'all', 'remnawave,redis', 'token-secret-remnawave']) {
      assert.throws(
        (): void => {
          validateEnvironment({
            ...createValidEnvironmentVariables(),
            REZEIS_ADMIN_EXTERNAL_READINESS_MODE: externalReadinessMode,
          });
        },
        (error: unknown): boolean => {
          assertEnvironmentConfigurationError(error);
          const message = error instanceof Error ? error.message : '';
          assert.match(message, /REZEIS_ADMIN_EXTERNAL_READINESS_MODE/);
          assert.doesNotMatch(message, /token-secret-remnawave/);
          return true;
        },
      );
    }
  });

  it('rejects unsafe CORS origins before runtime CORS is configured', () => {
    for (const corsOrigin of [
      '*',
      'https://admin.example.com/path',
      'https://admin.example.com?token=secret',
      'https://user:secret@admin.example.com',
      'ftp://admin.example.com',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'not-a-url',
      'https://admin.example.com,',
      'https://admin.example.com\r\nAccess-Control-Allow-Origin: *',
    ]) {
      assert.throws(
        (): void => {
          validateEnvironment({
            ...createValidEnvironmentVariables(),
            REZEIS_ADMIN_CORS_ORIGIN: corsOrigin,
          });
        },
        assertEnvironmentConfigurationError,
      );
    }
  });

  it('rejects unsafe Redis URLs before BullMQ receives them', () => {
    for (const redisUrl of [
      '   ',
      'http://localhost:6379/0',
      'redis://localhost:6379/0\r\nAUTH secret',
      'not-a-url',
    ]) {
      assert.throws(
        (): void => {
          validateEnvironment({
            ...createValidEnvironmentVariables(),
            REDIS_URL: redisUrl,
          });
        },
        assertEnvironmentConfigurationError,
      );
    }
  });

  it('formats environment validation failures without leaking raw secret values or stack traces', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REDIS_URL: 'redis://admin:super-secret-redis-password@cache.internal:6379/0\r\nAUTH leaked',
          REZEIS_ADMIN_DOCS_ENABLED: 'enabled-with-secret-token',
        });
      },
      (error: unknown): boolean => {
        assertEnvironmentConfigurationError(error);
        const serializedError = JSON.stringify(error);
        const message = error instanceof Error ? error.message : '';
        const stack = error instanceof Error ? error.stack : undefined;

        assert.match(message, /Environment configuration validation failed/);
        assert.match(message, /REDIS_URL/);
        assert.match(message, /REZEIS_ADMIN_DOCS_ENABLED/);
        assert.doesNotMatch(message, /super-secret-redis-password/);
        assert.doesNotMatch(message, /redis:\/\/admin/);
        assert.doesNotMatch(message, /enabled-with-secret-token/);
        assert.equal(stack, '');
        assert.doesNotMatch(serializedError, /super-secret-redis-password/);
        return true;
      },
    );
  });

  it('rejects placeholder/default values for secret-like environment variables without echoing them', () => {
    for (const [environmentKey, placeholderValue] of [
      ['REZEIS_ADMIN_JWT_SECRET', 'change_me'],
      ['REZEIS_ADMIN_INTERNAL_API_KEY', 'changeme'],
      ['REZEIS_ADMIN_METRICS_BASIC_PASSWORD', 'default'],
      ['REZEIS_ADMIN_SMTP_PASSWORD', 'password'],
      ['REMNAWAVE_TOKEN', 'secret'],
      ['REMNAWAVE_WEBHOOK_SECRET', 'replace-me'],
      ['REMNAWAVE_CADDY_TOKEN', 'example-secret'],
      ['REMNAWAVE_COOKIE', 'please-change'],
      ['BOT_TOKEN', 'token'],
    ] as const) {
      assert.throws(
        (): void => {
          validateEnvironment({
            ...createValidEnvironmentVariables(),
            REZEIS_ADMIN_METRICS_ACCESS_MODE:
              environmentKey === 'REZEIS_ADMIN_METRICS_BASIC_PASSWORD' ? 'basic' : 'open',
            REZEIS_ADMIN_METRICS_BASIC_USER:
              environmentKey === 'REZEIS_ADMIN_METRICS_BASIC_PASSWORD' ? 'prometheus' : undefined,
            REMNAWAVE_HOST: environmentKey.startsWith('REMNAWAVE_') ? 'remnawave' : undefined,
            REMNAWAVE_PORT: environmentKey.startsWith('REMNAWAVE_') ? '3000' : undefined,
            REMNAWAVE_TOKEN: environmentKey.startsWith('REMNAWAVE_') ? 'remnawave-runtime-token' : undefined,
            [environmentKey]: placeholderValue,
          });
        },
        (error: unknown): boolean => {
          assertEnvironmentConfigurationError(error);
          const message = error instanceof Error ? error.message : '';
          assert.match(message, new RegExp(environmentKey));
          assert.match(message, /must not use a placeholder value/);
          if (!environmentKey.toLowerCase().includes(placeholderValue.toLowerCase())) {
            assert.doesNotMatch(message, new RegExp(placeholderValue.replace('-', '[-_]'), 'i'));
            assert.doesNotMatch(JSON.stringify(error), new RegExp(placeholderValue, 'i'));
          }
          return true;
        },
      );
    }
  });

  it('accepts non-placeholder secret-like environment values', () => {
    const actualEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_JWT_SECRET: 'jwt-secret-v2-2026',
      REZEIS_ADMIN_INTERNAL_API_KEY: 'internal-api-key-v2-2026',
      REZEIS_ADMIN_METRICS_ACCESS_MODE: 'basic',
      REZEIS_ADMIN_METRICS_BASIC_USER: 'prometheus',
      REZEIS_ADMIN_METRICS_BASIC_PASSWORD: 'metrics-password-v2-2026',
      REZEIS_ADMIN_SMTP_PASSWORD: 'smtp-password-v2-2026',
      REMNAWAVE_HOST: 'remnawave',
      REMNAWAVE_PORT: '3000',
      REMNAWAVE_TOKEN: 'remnawave-token-v2-2026',
      REMNAWAVE_WEBHOOK_SECRET: 'remnawave-webhook-v2-2026',
      REMNAWAVE_CADDY_TOKEN: 'remnawave-caddy-v2-2026',
      REMNAWAVE_COOKIE: 'remnawave-cookie-v2-2026',
      BOT_TOKEN: 'telegram-bot-token-v2-2026',
    });

    assert.equal(actualEnvironment.REZEIS_ADMIN_JWT_SECRET, 'jwt-secret-v2-2026');
    assert.equal(actualEnvironment.REZEIS_ADMIN_INTERNAL_API_KEY, 'internal-api-key-v2-2026');
    assert.equal(actualEnvironment.REMNAWAVE_TOKEN, 'remnawave-token-v2-2026');
    assert.equal(actualEnvironment.BOT_TOKEN, 'telegram-bot-token-v2-2026');
  });

  it('validates JWT expiration as an ms-compatible duration before auth config consumes it', () => {
    for (const jwtExpiresIn of ['900', '15m', '2 h', '7d', '1week', '30 seconds']) {
      const actualEnvironment = validateEnvironment({
        ...createValidEnvironmentVariables(),
        REZEIS_ADMIN_JWT_EXPIRES_IN: jwtExpiresIn,
      });

      assert.equal(actualEnvironment.REZEIS_ADMIN_JWT_EXPIRES_IN, jwtExpiresIn);
    }
  });

  it('rejects invalid JWT expiration values without echoing raw secret-like input', () => {
    for (const jwtExpiresIn of ['forever', '12parsecs', '1;token=super-secret', 'https://auth.example.com/token']) {
      assert.throws(
        (): void => {
          validateEnvironment({
            ...createValidEnvironmentVariables(),
            REZEIS_ADMIN_JWT_EXPIRES_IN: jwtExpiresIn,
          });
        },
        (error: unknown): boolean => {
          assertEnvironmentConfigurationError(error);
          const message = error instanceof Error ? error.message : '';
          assert.match(message, /REZEIS_ADMIN_JWT_EXPIRES_IN/);
          assert.match(message, /ms-compatible duration/);
          assert.doesNotMatch(message, /super-secret/i);
          assert.doesNotMatch(message, /auth\.example\.com/i);
          assert.doesNotMatch(JSON.stringify(error), /super-secret/i);
          return true;
        },
      );
    }
  });

  it('rejects basic-auth protected metrics mode without complete credentials', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_METRICS_ACCESS_MODE: 'basic',
          REZEIS_ADMIN_METRICS_BASIC_USER: 'prometheus',
        });
      },
      assertEnvironmentConfigurationError,
    );
  });

  it('rejects unsafe metrics basic-auth usernames', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_METRICS_ACCESS_MODE: 'basic',
          REZEIS_ADMIN_METRICS_BASIC_USER: 'prometheus:admin',
          REZEIS_ADMIN_METRICS_BASIC_PASSWORD: 'metrics-password',
        });
      },
      assertEnvironmentConfigurationError,
    );
  });

  it('treats whitespace-only optional SMTP values as omitted', () => {
    const actualEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_SMTP_USER: '   ',
      REZEIS_ADMIN_SMTP_PASSWORD: '   ',
      REZEIS_ADMIN_SMTP_REPLY_TO: '   ',
      REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN: '   ',
    });
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_USER, undefined);
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_PASSWORD, undefined);
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_REPLY_TO, undefined);
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN, undefined);
  });

  it('rejects an invalid SMTP sender address', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_SMTP_FROM_ADDRESS: 'not-an-email',
        });
      },
      assertEnvironmentConfigurationError,
    );
  });

  it('rejects SMTP timeout values above the bounded resource limit without echoing the raw value', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_SMTP_TIMEOUT_MS: '60001',
        });
      },
      (error: unknown): boolean => {
        assertEnvironmentConfigurationError(error);
        const message = error instanceof Error ? error.message : '';
        assert.match(message, /REZEIS_ADMIN_SMTP_TIMEOUT_MS/);
        assert.doesNotMatch(message, /60001/);
        return true;
      },
    );
  });

  it('rejects partial SMTP authentication configuration', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_SMTP_PASSWORD: '',
        });
      },
      assertEnvironmentConfigurationError,
    );
  });

  it('rejects an unsafe SMTP identity domain', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN: 'bad domain\r\n',
        });
      },
      assertEnvironmentConfigurationError,
    );
  });

  it('accepts a valid SMTP identity domain', () => {
    const actualEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN: 'mail.example.com',
    });
    assert.equal(actualEnvironment.REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN, 'mail.example.com');
  });

  it('rejects SMTP sender names with control characters', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REZEIS_ADMIN_SMTP_FROM_NAME: 'Rezeis\r\nAdmin',
        });
      },
      assertEnvironmentConfigurationError,
    );
  });

  it('requires remnawave host, port, and token together when any remnawave value is present', () => {
    assert.throws(
      (): void => {
        validateEnvironment({
          ...createValidEnvironmentVariables(),
          REMNAWAVE_HOST: 'remnawave',
        });
      },
      assertEnvironmentConfigurationError,
    );

    const actualEnvironment = validateEnvironment({
      ...createValidEnvironmentVariables(),
      REMNAWAVE_HOST: 'remnawave',
      REMNAWAVE_PORT: '3000',
      REMNAWAVE_TOKEN: 'remnawave-token-v2',
    });

    assert.equal(actualEnvironment.REMNAWAVE_HOST, 'remnawave');
    assert.equal(actualEnvironment.REMNAWAVE_PORT, 3000);
    assert.equal(actualEnvironment.REMNAWAVE_TOKEN, 'remnawave-token-v2');
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
  assert.doesNotMatch(error.message, /ZodError/);
  return true;
}
