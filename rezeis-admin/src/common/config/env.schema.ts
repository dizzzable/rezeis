import { z } from 'zod';

const normalizeOptionalString = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  return v === '' ? undefined : v;
};

const webhookSecretPattern = /^[a-zA-Z0-9]{64}$/;

const environmentSchema = z.object({
  // ── Application ──────────────────────────────────────────────────────────
  REZEIS_DOMAIN: z.string().min(1).default('localhost'),
  REZEIS_HOST: z.string().min(1).default('0.0.0.0'),
  REZEIS_PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  REZEIS_LOCALES: z.string().min(1).default('ru,en'),
  REZEIS_DEFAULT_LOCALE: z.string().min(1).default('ru'),
  REZEIS_CRYPT_KEY: z.string().min(1),

  // ── Webhook ──────────────────────────────────────────────────────────────
  WEBHOOK_ENABLED: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(false)),
  WEBHOOK_URL: z.preprocess(normalizeOptionalString, z.string().url().optional()),
  WEBHOOK_SECRET_HEADER: z.preprocess(
    normalizeOptionalString,
    z.string().regex(webhookSecretPattern, 'WEBHOOK_SECRET_HEADER must be exactly 64 alphanumeric characters').optional(),
  ),

  // ── Remnawave ────────────────────────────────────────────────────────────
  REMNAWAVE_HOST: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),
  REMNAWAVE_PORT: z.preprocess(normalizeOptionalString, z.coerce.number().int().min(1).max(65535).optional()),
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
  DATABASE_ECHO: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(false)),
  DATABASE_ECHO_POOL: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(false)),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).default(25),
  DATABASE_MAX_OVERFLOW: z.coerce.number().int().min(0).default(25),
  DATABASE_POOL_TIMEOUT: z.coerce.number().int().min(1).default(10),
  DATABASE_POOL_RECYCLE: z.coerce.number().int().min(1).default(3600),

  // ── Redis ────────────────────────────────────────────────────────────────
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_NAME: z.coerce.number().int().min(0).default(0),
  REDIS_PASSWORD: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),

  // ── Backup ───────────────────────────────────────────────────────────────
  BACKUP_AUTO_ENABLED: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(true)),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).default(24),
  BACKUP_TIME: z.string().default('00:00'),
  BACKUP_MAX_KEEP: z.coerce.number().int().min(1).default(7),
  BACKUP_COMPRESSION: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(true)),
  BACKUP_INCLUDE_LOGS: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(false)),
  BACKUP_LOCATION: z.string().default('/app/data/backups'),
  BACKUP_SEND_ENABLED: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(false)),
  BACKUP_SEND_CHAT_ID: z.preprocess(normalizeOptionalString, z.string().optional()),
  BACKUP_SEND_TOPIC_ID: z.preprocess(normalizeOptionalString, z.string().optional()),

  // ── Email (SMTP) ─────────────────────────────────────────────────────────
  EMAIL_ENABLED: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(false)),
  EMAIL_HOST: z.preprocess(normalizeOptionalString, z.string().optional()),
  EMAIL_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  EMAIL_USERNAME: z.preprocess(normalizeOptionalString, z.string().optional()),
  EMAIL_PASSWORD: z.preprocess(normalizeOptionalString, z.string().optional()),
  EMAIL_FROM_ADDRESS: z.string().default('no-reply@rezeis.local'),
  EMAIL_FROM_NAME: z.string().default('Rezeis'),
  EMAIL_USE_TLS: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(true)),
  EMAIL_USE_SSL: z.preprocess((v) => v === 'true' || v === true, z.boolean().default(false)),

  // ── Reiwa internal channel ───────────────────────────────────────────────
  /** URL of reiwa-bot's internal HTTP listener (for /invalidate, /notify).
   * Default targets the docker DNS name; override in dev / staging when
   * the bot lives on a different host. Skipped entirely when unset. */
  REIWA_BOT_URL: z.preprocess(
    normalizeOptionalString,
    z.string().url().default('http://reiwa-bot:5100'),
  ),
  /** Shared bearer token used by both the outbound /invalidate and /notify
   * calls and by reiwa's incoming guard. Must match
   * `REZEIS_INTERNAL_SHARED_SECRET` on reiwa side. Disabled when unset. */
  REZEIS_INTERNAL_SHARED_SECRET: z.preprocess(normalizeOptionalString, z.string().min(16).optional()),

  // ── Update checker ───────────────────────────────────────────────────────
  /** Panel `<owner>/<repo>` GitHub slug whose `releases/latest` is compared
   * against the running panel version. Unset = update checks disabled. */
  REZEIS_UPDATE_REPO: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),
  /** reiwa `<owner>/<repo>` GitHub slug. When set, the Updates widget also
   * surfaces the latest reiwa release vs. the version reiwa reports in. */
  REZEIS_REIWA_UPDATE_REPO: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),
});

export type AppEnvironment = z.infer<typeof environmentSchema>;

/**
 * Validates and normalizes process environment variables.
 */
export function validateEnvironment(
  environmentVariables: Record<string, unknown>,
): AppEnvironment {
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
