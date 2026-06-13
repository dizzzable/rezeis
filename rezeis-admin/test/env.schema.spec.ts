import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDatabaseUrl,
  buildRedisUrl,
  validateEnvironment,
} from '../src/common/config/env.schema';

describe('validateEnvironment', () => {
  it('parses required secrets and runtime defaults', () => {
    const actualEnvironment = validateEnvironment(createRequiredEnvironment());

    assert.equal(actualEnvironment.NODE_ENV, 'development');
    assert.equal(actualEnvironment.REZEIS_DOMAIN, 'localhost');
    assert.equal(actualEnvironment.REZEIS_HOST, '0.0.0.0');
    assert.equal(actualEnvironment.REZEIS_PORT, 8000);
    assert.equal(actualEnvironment.REZEIS_LOCALES, 'ru,en');
    assert.equal(actualEnvironment.REZEIS_DEFAULT_LOCALE, 'ru');
    assert.equal(actualEnvironment.REZEIS_CRYPT_KEY, 'crypt-key-v2-that-is-32plus-bytes-long!!');
    assert.equal(actualEnvironment.DATABASE_HOST, 'localhost');
    assert.equal(actualEnvironment.DATABASE_PORT, 5432);
    assert.equal(actualEnvironment.DATABASE_NAME, 'rezeis');
    assert.equal(actualEnvironment.DATABASE_USER, 'rezeis');
    assert.equal(actualEnvironment.DATABASE_PASSWORD, 'database-password-v2');
    assert.equal(actualEnvironment.REDIS_HOST, 'localhost');
    assert.equal(actualEnvironment.REDIS_PORT, 6379);
    assert.equal(actualEnvironment.REDIS_NAME, 0);
    assert.equal(actualEnvironment.BACKUP_AUTO_ENABLED, true);
    assert.equal(actualEnvironment.BACKUP_COMPRESSION, true);
    assert.equal(actualEnvironment.EMAIL_ENABLED, false);
    assert.equal(actualEnvironment.EMAIL_PORT, 587);
    assert.equal(actualEnvironment.EMAIL_FROM_ADDRESS, 'no-reply@rezeis.local');
    assert.equal(actualEnvironment.EMAIL_FROM_NAME, 'Rezeis');
    assert.equal(actualEnvironment.EMAIL_USE_TLS, true);
    assert.equal(actualEnvironment.EMAIL_USE_SSL, false);
    assert.equal(actualEnvironment.REIWA_URL, 'http://reiwa:5000');
  });

  it('coerces split database and Redis config and builds service URLs', () => {
    const actualEnvironment = validateEnvironment({
      ...createRequiredEnvironment(),
      DATABASE_HOST: 'db.internal',
      DATABASE_PORT: '6543',
      DATABASE_NAME: 'rezeis_prod',
      DATABASE_USER: 'rezeis_user',
      DATABASE_PASSWORD: 'p@ ss',
      REDIS_HOST: 'redis.internal',
      REDIS_PORT: '6380',
      REDIS_NAME: '2',
      REDIS_PASSWORD: 'redis password',
    });

    assert.equal(actualEnvironment.DATABASE_PORT, 6543);
    assert.equal(actualEnvironment.REDIS_PORT, 6380);
    assert.equal(actualEnvironment.REDIS_NAME, 2);
    assert.equal(buildDatabaseUrl(actualEnvironment), 'postgresql://rezeis_user:p%40%20ss@db.internal:6543/rezeis_prod');
    assert.equal(buildRedisUrl(actualEnvironment), 'redis://:redis%20password@redis.internal:6380/2');
  });

  it('normalizes blank optional string values to omitted values', () => {
    const actualEnvironment = validateEnvironment({
      ...createRequiredEnvironment(),
      WEBHOOK_URL: '   ',
      WEBHOOK_SECRET_HEADER: '   ',
      REMNAWAVE_HOST: '   ',
      REMNAWAVE_PORT: '   ',
      REMNAWAVE_TOKEN: '   ',
      REDIS_PASSWORD: '   ',
      REZEIS_UPDATE_REPO: '   ',
      REZEIS_REIWA_UPDATE_REPO: '   ',
    });

    assert.equal(actualEnvironment.WEBHOOK_URL, undefined);
    assert.equal(actualEnvironment.WEBHOOK_SECRET_HEADER, undefined);
    assert.equal(actualEnvironment.REMNAWAVE_HOST, undefined);
    assert.equal(actualEnvironment.REMNAWAVE_PORT, undefined);
    assert.equal(actualEnvironment.REMNAWAVE_TOKEN, undefined);
    assert.equal(actualEnvironment.REDIS_PASSWORD, undefined);
    assert.equal(actualEnvironment.REZEIS_UPDATE_REPO, undefined);
    assert.equal(actualEnvironment.REZEIS_REIWA_UPDATE_REPO, undefined);
  });

  it('accepts explicit optional integration configuration', () => {
    const actualEnvironment = validateEnvironment({
      ...createRequiredEnvironment(),
      WEBHOOK_ENABLED: 'true',
      WEBHOOK_URL: 'https://hooks.example.com/rezeis',
      WEBHOOK_SECRET_HEADER: 'a'.repeat(64),
      REMNAWAVE_HOST: 'remnawave.internal',
      REMNAWAVE_PORT: '3001',
      REMNAWAVE_TOKEN: 'remnawave-token-v2',
      REMNAWAVE_WEBHOOK_SECRET: 'remnawave-webhook-secret-v2',
      REMNAWAVE_CADDY_TOKEN: 'remnawave-caddy-token-v2',
      REMNAWAVE_COOKIE: 'remnawave-cookie-v2',
      REZEIS_UPDATE_REPO: 'owner/rezeis',
      REZEIS_REIWA_UPDATE_REPO: 'owner/reiwa',
    });

    assert.equal(actualEnvironment.WEBHOOK_ENABLED, true);
    assert.equal(actualEnvironment.WEBHOOK_URL, 'https://hooks.example.com/rezeis');
    assert.equal(actualEnvironment.WEBHOOK_SECRET_HEADER, 'a'.repeat(64));
    assert.equal(actualEnvironment.REMNAWAVE_HOST, 'remnawave.internal');
    assert.equal(actualEnvironment.REMNAWAVE_PORT, 3001);
    assert.equal(actualEnvironment.REMNAWAVE_TOKEN, 'remnawave-token-v2');
    assert.equal(actualEnvironment.REZEIS_UPDATE_REPO, 'owner/rezeis');
    assert.equal(actualEnvironment.REZEIS_REIWA_UPDATE_REPO, 'owner/reiwa');
  });

  it('requires crypt and database secrets', () => {
    assert.throws(() => {
      validateEnvironment({ DATABASE_PASSWORD: 'database-password-v2' });
    });
    assert.throws(() => {
      validateEnvironment({ REZEIS_CRYPT_KEY: 'crypt-key-v2-that-is-32plus-bytes-long!!' });
    });
  });

  it('requires explicit admin CORS origins in production', () => {
    assert.throws(
      () => validateEnvironment({
        ...createRequiredEnvironment(),
        NODE_ENV: 'production',
      }),
      /ADMIN_CORS_ORIGINS must define at least one trusted admin origin/,
    );

    const actualEnvironment = validateEnvironment({
      ...createRequiredEnvironment(),
      NODE_ENV: 'production',
      ADMIN_CORS_ORIGINS: 'https://admin.example.com',
    });

    assert.equal(actualEnvironment.NODE_ENV, 'production');
    assert.equal(actualEnvironment.ADMIN_CORS_ORIGINS, 'https://admin.example.com');
  });

  it('rejects wildcard and invalid admin CORS origins', () => {
    for (const invalidEnvironment of [
      { ADMIN_CORS_ORIGINS: '*' },
      { ADMIN_CORS_ORIGINS: 'not-a-url' },
      { ADMIN_CORS_ORIGINS: 'ftp://admin.example.com' },
      { ADMIN_CORS_ORIGINS: 'https://user:pass@admin.example.com' },
      { ADMIN_CORS_ORIGINS: 'https://admin.example.com/panel' },
      { ADMIN_CORS_ORIGINS: 'https://admin.example.com?token=secret' },
      { ADMIN_CORS_ORIGINS: 'https://admin.example.com#fragment' },
    ]) {
      assert.throws(() => {
        validateEnvironment({
          ...createRequiredEnvironment(),
          ...invalidEnvironment,
        });
      }, /ADMIN_CORS_ORIGINS/);
    }
  });

  it('rejects unsafe admin CORS origins without echoing raw origin values', () => {
    assert.throws(
      () => validateEnvironment({
        ...createRequiredEnvironment(),
        ADMIN_CORS_ORIGINS: 'https://admin.example.com?token=secret-token',
      }),
      (error: unknown): boolean => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ADMIN_CORS_ORIGINS/);
        assert.doesNotMatch(error.message, /secret-token/);
        assert.doesNotMatch(error.message, /admin\.example\.com/);
        return true;
      },
    );
  });

  it('rejects invalid numeric and URL inputs before bootstrap continues', () => {
    for (const invalidEnvironment of [
      { REZEIS_PORT: '0' },
      { DATABASE_PORT: '70000' },
      { REDIS_PORT: '0' },
      { REDIS_NAME: '-1' },
      { WEBHOOK_URL: 'not-a-url' },
      { REIWA_URL: 'not-a-url' },
    ]) {
      assert.throws(() => {
        validateEnvironment({
          ...createRequiredEnvironment(),
          ...invalidEnvironment,
        });
      });
    }
  });

  it('disables (does not crash on) a malformed WEBHOOK_SECRET_HEADER', () => {
    // An optional integration secret must not take down the whole panel.
    // A malformed value is coerced to undefined (signing disabled) + a warning.
    for (const bad of ['short', 'has-dashes-' + 'a'.repeat(54), 'a'.repeat(63), 'a'.repeat(65)]) {
      const env = validateEnvironment({
        ...createRequiredEnvironment(),
        WEBHOOK_SECRET_HEADER: bad,
      });
      assert.equal(env.WEBHOOK_SECRET_HEADER, undefined);
    }
    // A valid 64-char alphanumeric value is preserved.
    const ok = validateEnvironment({
      ...createRequiredEnvironment(),
      WEBHOOK_SECRET_HEADER: 'a'.repeat(64),
    });
    assert.equal(ok.WEBHOOK_SECRET_HEADER, 'a'.repeat(64));
  });

  it('parses booleans leniently while preserving true defaults', () => {
    const defaultEnvironment = validateEnvironment(createRequiredEnvironment());
    assert.equal(defaultEnvironment.BACKUP_AUTO_ENABLED, true);
    assert.equal(defaultEnvironment.BACKUP_COMPRESSION, true);
    assert.equal(defaultEnvironment.EMAIL_USE_TLS, true);

    const explicitEnvironment = validateEnvironment({
      ...createRequiredEnvironment(),
      BACKUP_AUTO_ENABLED: 'false',
      BACKUP_COMPRESSION: 'false',
      EMAIL_USE_TLS: 'false',
      EMAIL_ENABLED: 'true',
      EMAIL_USE_SSL: 'true',
    });
    assert.equal(explicitEnvironment.BACKUP_AUTO_ENABLED, false);
    assert.equal(explicitEnvironment.BACKUP_COMPRESSION, false);
    assert.equal(explicitEnvironment.EMAIL_USE_TLS, false);
    assert.equal(explicitEnvironment.EMAIL_ENABLED, true);
    assert.equal(explicitEnvironment.EMAIL_USE_SSL, true);

    // Common synonyms are accepted (1/0, yes/no, on/off).
    const synonyms = validateEnvironment({
      ...createRequiredEnvironment(),
      EMAIL_ENABLED: 'yes',
      EMAIL_USE_SSL: 'on',
      BACKUP_COMPRESSION: '0',
    });
    assert.equal(synonyms.EMAIL_ENABLED, true);
    assert.equal(synonyms.EMAIL_USE_SSL, true);
    assert.equal(synonyms.BACKUP_COMPRESSION, false);

    // A blank value must NOT crash the boot — it falls back to the default.
    const blank = validateEnvironment({
      ...createRequiredEnvironment(),
      WEBHOOK_ENABLED: '',
      BACKUP_AUTO_ENABLED: '',
    });
    assert.equal(blank.WEBHOOK_ENABLED, false);
    assert.equal(blank.BACKUP_AUTO_ENABLED, true);

    // A genuinely unparseable value still fails closed.
    assert.throws(() => {
      validateEnvironment({
        ...createRequiredEnvironment(),
        EMAIL_ENABLED: 'maybe',
      });
    });
  });
});

function createRequiredEnvironment(): Record<string, unknown> {
  return {
    REZEIS_CRYPT_KEY: 'crypt-key-v2-that-is-32plus-bytes-long!!',
    DATABASE_PASSWORD: 'database-password-v2',
  };
}
