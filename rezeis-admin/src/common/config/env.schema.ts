import { z } from 'zod';

import { parseCorsOrigins } from '../http/cors-origin';

const normalizeOptionalString = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  return v === '' ? undefined : v;
};

const envBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined) return undefined;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      // Blank value → fall back to the default instead of crashing the boot.
      // A common install mistake is leaving `WEBHOOK_ENABLED=` empty.
      if (normalized === '') return undefined;
      if (
        normalized === 'true' ||
        normalized === '1' ||
        normalized === 'yes' ||
        normalized === 'on'
      ) {
        return true;
      }
      if (
        normalized === 'false' ||
        normalized === '0' ||
        normalized === 'no' ||
        normalized === 'off'
      ) {
        return false;
      }
    }
    return value;
  }, z.boolean().default(defaultValue));

const webhookSecretPattern = /^[a-zA-Z0-9]{64,256}$/;

const environmentSchema = z
  .object({
    // ── Application ──────────────────────────────────────────────────────────
    NODE_ENV: z.preprocess(normalizeOptionalString, z.string().min(1).default('development')),
    REZEIS_DOMAIN: z.string().min(1).default('localhost'),
    REZEIS_HOST: z.string().min(1).default('0.0.0.0'),
    REZEIS_PORT: z.coerce.number().int().min(1).max(65535).default(8000),
    API_DOCS_ENABLED: envBoolean(false),
    ADMIN_CORS_ORIGINS: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),
    ADMIN_TRUST_PROXY: z.preprocess(
      normalizeOptionalString,
      z.enum(['disabled', 'loopback', 'linklocal', 'uniquelocal']).default('disabled'),
    ),
    REZEIS_LOCALES: z.string().min(1).default('ru,en'),
    REZEIS_DEFAULT_LOCALE: z.string().min(1).default('ru'),
    REZEIS_CRYPT_KEY: z.string().min(32, 'REZEIS_CRYPT_KEY must be at least 32 characters'),

    // ── Webhook ──────────────────────────────────────────────────────────────
    WEBHOOK_ENABLED: envBoolean(false),
    WEBHOOK_URL: z.preprocess(normalizeOptionalString, z.string().url().optional()),
    WEBHOOK_SECRET_HEADER: z.preprocess((value) => {
      const normalized = normalizeOptionalString(value);
      // WEBHOOK_SECRET_HEADER is an OPTIONAL integration secret (signs the
      // reiwa push channel + outbound webhooks). A malformed value must NOT
      // crash the whole panel — disable webhook signing and warn loudly so the
      // operator fixes it. Core secrets like REZEIS_CRYPT_KEY still fail closed.
      if (typeof normalized === 'string' && !webhookSecretPattern.test(normalized)) {
        console.warn(
          '[env] WEBHOOK_SECRET_HEADER is set but is not 64–256 alphanumeric characters — ' +
            'webhook signing (reiwa push / outbound webhooks) is DISABLED. ' +
            'Set a valid value (e.g. `openssl rand -hex 32`) or leave it empty.',
        );
        return undefined;
      }
      return normalized;
    }, z.string().regex(webhookSecretPattern).optional()),

    // ── Remnawave ────────────────────────────────────────────────────────────
    REMNAWAVE_HOST: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),
    REMNAWAVE_PORT: z.preprocess(
      normalizeOptionalString,
      z.coerce.number().int().min(1).max(65535).optional(),
    ),
    REMNAWAVE_TOKEN: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),
    REMNAWAVE_WEBHOOK_SECRET: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),
    REMNAWAVE_CADDY_TOKEN: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),
    REMNAWAVE_COOKIE: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),

    // ── Database ─────────────────────────────────────────────────────────────
    DATABASE_HOST: z.string().min(1).default('localhost'),
    DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
    DATABASE_NAME: z.string().min(1).default('rezeis'),
    DATABASE_USER: z.string().min(1).default('rezeis'),
    DATABASE_PASSWORD: z.string().min(1),
    DATABASE_ECHO: envBoolean(false),
    DATABASE_ECHO_POOL: envBoolean(false),
    // Optional: explicit Postgres connection-pool max. When unset/blank, the
    // pool is auto-sized to the container's memory budget (resource-profile.util).
    DATABASE_POOL_SIZE: z.preprocess(
      normalizeOptionalString,
      z.coerce.number().int().min(1).optional(),
    ),
    DATABASE_MAX_OVERFLOW: z.coerce.number().int().min(0).default(25),
    DATABASE_POOL_TIMEOUT: z.coerce.number().int().min(1).default(10),
    DATABASE_POOL_RECYCLE: z.coerce.number().int().min(1).default(3600),

    // ── Redis ────────────────────────────────────────────────────────────────
    REDIS_HOST: z.string().min(1).default('localhost'),
    REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
    REDIS_NAME: z.coerce.number().int().min(0).default(0),
    REDIS_PASSWORD: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),

    // ── Backup ───────────────────────────────────────────────────────────────
    BACKUP_AUTO_ENABLED: envBoolean(true),
    BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).default(24),
    BACKUP_TIME: z.string().default('00:00'),
    BACKUP_MAX_KEEP: z.coerce.number().int().min(1).default(7),
    BACKUP_COMPRESSION: envBoolean(true),
    BACKUP_INCLUDE_LOGS: envBoolean(false),
    BACKUP_LOCATION: z.string().default('/app/data/backups'),
    BACKUP_SEND_ENABLED: envBoolean(false),
    BACKUP_SEND_CHAT_ID: z.preprocess(normalizeOptionalString, z.string().optional()),
    BACKUP_SEND_TOPIC_ID: z.preprocess(normalizeOptionalString, z.string().optional()),

    // ── Email (SMTP) ─────────────────────────────────────────────────────────
    EMAIL_ENABLED: envBoolean(false),
    EMAIL_HOST: z.preprocess(normalizeOptionalString, z.string().optional()),
    EMAIL_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    EMAIL_USERNAME: z.preprocess(normalizeOptionalString, z.string().optional()),
    EMAIL_PASSWORD: z.preprocess(normalizeOptionalString, z.string().optional()),
    EMAIL_FROM_ADDRESS: z.string().default('no-reply@rezeis.local'),
    EMAIL_FROM_NAME: z.string().default('Rezeis'),
    EMAIL_USE_TLS: envBoolean(true),
    EMAIL_USE_SSL: envBoolean(false),

    // ── Reiwa internal channel ───────────────────────────────────────────────
    /** Public base URL of reiwa (the user-facing edge). admin delivers
     * operator webhooks here (`POST <REIWA_URL>/api/v1/webhooks/rezeis`):
     * bot-config cache busts + per-user/broadcast notifications. reiwa-api
     * receives, verifies the signature, and relays to the bot internally —
     * the bot itself is never exposed. Same-VPS default points at the docker
     * service; split deploy uses the public https domain. Skipped when unset. */
    REIWA_URL: z.preprocess(normalizeOptionalString, z.string().url().default('http://reiwa:5000')),

    // ── Subscription page (rezeis-subpage) ───────────────────────────────────
    /** Base URL of rezeis-subpage. admin pushes a config cache-invalidate here
     * (`POST <REZEIS_SUBPAGE_URL>/internal/subpage-config/invalidate`) after any
     * subpage-config save, so branding/app changes appear immediately instead of
     * waiting for the subpage TTL. Same-VPS default points at the docker service;
     * split deploy uses the public https domain. Invalidate push is skipped when
     * unset (or when the secret below is unset). */
    REZEIS_SUBPAGE_URL: z.preprocess(normalizeOptionalString, z.string().url().optional()),
    /** Shared bearer secret for the subpage invalidate webhook. Must equal the
     * subpage's `REZEIS_SUBPAGE_WEBHOOK_SECRET`. Leave empty to disable the push
     * (the subpage still refreshes on its TTL). */
    REZEIS_SUBPAGE_WEBHOOK_SECRET: z.preprocess(
      normalizeOptionalString,
      z.string().min(16).optional(),
    ),

    /**
     * Per-partner HMAC secrets for PARTNER_TASK quest callbacks, as a JSON
     * object `{"<partnerSlug>":"<secret>"}`. Each secret signs that partner's
     * postback (`t=<sec>,v1=<hmac>` over `<t>.<rawBody>`). Malformed JSON is
     * tolerated (no partners configured) rather than crashing the panel; a
     * partner quest simply can't be created until its slug has a secret here.
     */
    QUEST_PARTNER_SECRETS: z.preprocess(normalizeOptionalString, z.string().optional()),

    // ── Update checker ───────────────────────────────────────────────────────
    /** Optional override for the panel `<owner>/<repo>` GitHub slug whose
     * `releases/latest` is compared against the running version. The upstream
     * repo is baked into the build as a default (see update-checker.service),
     * so leaving this unset still performs the check — set it only on a fork. */
    REZEIS_UPDATE_REPO: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),
    /** Optional override for the reiwa `<owner>/<repo>` GitHub slug. Defaults
     * are baked in; the Updates widget surfaces the latest reiwa release vs.
     * the version reiwa reports in over the internal channel. */
    REZEIS_REIWA_UPDATE_REPO: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),
  })
  .superRefine((env, ctx) => {
    try {
      parseCorsOrigins(env.ADMIN_CORS_ORIGINS, {
        requireConfiguredOrigins: env.NODE_ENV === 'production',
      });
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_CORS_ORIGINS'],
        message: error instanceof Error ? error.message : 'Invalid ADMIN_CORS_ORIGINS value',
      });
    }
  });

export type AppEnvironment = z.infer<typeof environmentSchema>;

/**
 * Validates and normalizes process environment variables.
 */
export function validateEnvironment(environmentVariables: Record<string, unknown>): AppEnvironment {
  return environmentSchema.parse(environmentVariables);
}

/**
 * Builds a PostgreSQL connection URL from individual DATABASE_* variables.
 */
export function buildDatabaseUrl(env: AppEnvironment): string {
  const password = encodeURIComponent(env.DATABASE_PASSWORD);
  return `postgresql://${env.DATABASE_USER}:${password}@${env.DATABASE_HOST}:${env.DATABASE_PORT}/${env.DATABASE_NAME}`;
}

/**
 * Builds a Redis connection URL from individual REDIS_* variables.
 */
export function buildRedisUrl(env: AppEnvironment): string {
  const auth = env.REDIS_PASSWORD ? `:${encodeURIComponent(env.REDIS_PASSWORD)}@` : '';
  return `redis://${auth}${env.REDIS_HOST}:${env.REDIS_PORT}/${env.REDIS_NAME}`;
}
