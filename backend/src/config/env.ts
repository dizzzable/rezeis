import { z } from 'zod';

/**
 * Remnawave configuration schema
 * Mirrors the configuration from rezeis bot
 */
const _remnawaveSchema = z.object({
  host: z.string().default('remnawave'),
  port: z.string().default('3000').transform(Number),
  token: z.string().min(1, 'REMNAWAVE_TOKEN is required'),
  webhookSecret: z.string().min(1, 'REMNAWAVE_WEBHOOK_SECRET is required'),
  caddyToken: z.string().optional().default(''),
  cookie: z.string().optional().default(''),
  syncIntervalMinutes: z.string().default('5').transform(Number),
  syncEnabled: z.string().default('true').transform((v) => v === 'true'),
});

/**
 * Database configuration schema
 */
const _databaseSchema = z.object({
  host: z.string().default('localhost'),
  port: z.string().default('5432').transform(Number),
  name: z.string().default('rezeis_panel'),
  user: z.string().default('rezeis'),
  password: z.string().default('rezeis_dev'),
  url: z.string().optional(),
  poolSize: z.string().default('10').transform(Number),
  maxOverflow: z.string().default('20').transform(Number),
  poolTimeout: z.string().default('30').transform(Number),
});

/**
 * Redis configuration schema
 */
const _redisSchema = z.object({
  host: z.string().default('localhost'),
  port: z.string().default('6379').transform(Number),
  name: z.string().default('0'),
  password: z.string().optional().default(''),
  url: z.string().optional(),
});

/**
 * JWT configuration schema
 */
const _jwtSchema = z.object({
  secret: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  expiresIn: z.string().default('7d'),
  refreshSecret: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  refreshExpiresIn: z.string().default('30d'),
});

/**
 * Telegram configuration schema
 */
const _telegramSchema = z.object({
  botToken: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  webhookSecret: z.string().optional().default(''),
  miniAppUrl: z.string().optional().default(''),
});

/**
 * Feature flags configuration schema
 */
const _featureFlagsSchema = z.object({
  paymentsEnabled: z.string().default('true').transform((v) => v === 'true'),
  referralEnabled: z.string().default('true').transform((v) => v === 'true'),
  partnerEnabled: z.string().default('true').transform((v) => v === 'true'),
  websocketEnabled: z.string().default('true').transform((v) => v === 'true'),
});

/**
 * Main environment variables schema validation
 * Unified configuration following rezeis bot pattern
 */
const envSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_DOMAIN: z.string().default('localhost'),

  // Ports
  APP_BACKEND_PORT: z.string().default('4000').transform(Number),
  APP_FRONTEND_PORT: z.string().default('4001').transform(Number),
  APP_MINIAPP_PORT: z.string().default('4002').transform(Number),
  APP_WEBSOCKET_PORT: z.string().default('4003').transform(Number),

  // Database
  DATABASE_HOST: z.string().default('localhost'),
  DATABASE_PORT: z.string().default('5432').transform(Number),
  DATABASE_NAME: z.string().default('rezeis_panel'),
  DATABASE_USER: z.string().default('rezeis'),
  DATABASE_PASSWORD: z.string().default('rezeis_dev'),
  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_SIZE: z.string().default('10').transform(Number),
  DATABASE_MAX_OVERFLOW: z.string().default('20').transform(Number),
  DATABASE_POOL_TIMEOUT: z.string().default('30').transform(Number),

  // Valkey (formerly Redis)
  VALKEY_HOST: z.string().default('localhost'),
  VALKEY_PORT: z.string().default('6379').transform(Number),
  VALKEY_PASSWORD: z.string().optional().default(''),
  VALKEY_DB: z.string().default('0'),
  VALKEY_URL: z.string().optional(),
  VALKEY_MAX_CONNECTIONS: z.string().default('10').transform(Number),

  // Redis (backward compatibility)
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379').transform(Number),
  REDIS_NAME: z.string().default('0'),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_URL: z.string().optional(),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  // Remnawave
  REMNAWAVE_HOST: z.string().default('remnawave'),
  REMNAWAVE_PORT: z.string().default('3000').transform(Number),
  REMNAWAVE_TOKEN: z.string().min(1, 'REMNAWAVE_TOKEN is required'),
  REMNAWAVE_WEBHOOK_SECRET: z.string().min(1, 'REMNAWAVE_WEBHOOK_SECRET is required'),
  REMNAWAVE_CADDY_TOKEN: z.string().optional().default(''),
  REMNAWAVE_COOKIE: z.string().optional().default(''),
  REMNAWAVE_SYNC_INTERVAL_MINUTES: z.string().default('5').transform(Number),
  REMNAWAVE_SYNC_ENABLED: z.string().default('true').transform((v) => v === 'true'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(''),
  TELEGRAM_MINI_APP_URL: z.string().optional().default(''),

  // Access Control
  SUPER_ADMIN_TELEGRAM_ID: z.string().min(1, 'SUPER_ADMIN_TELEGRAM_ID is required'),

  // Rate Limiting
  RATE_LIMIT_MAX: z.string().default('1000').transform(Number),
  RATE_LIMIT_WINDOW_MS: z.string().default('60000').transform(Number),
  CORS_ORIGINS: z.string().optional().default(''),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),

  // Feature Flags
  FEATURE_PAYMENTS_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  FEATURE_REFERRAL_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  FEATURE_PARTNER_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  FEATURE_WEBSOCKET_ENABLED: z.string().default('true').transform((v) => v === 'true'),

  // Backup Configuration
  BACKUP_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  BACKUP_INTERVAL_HOURS: z.string().default('24').transform(Number),
  BACKUP_TIME: z.string().default('03:00'),
  BACKUP_MAX_KEEP: z.string().default('7').transform(Number),
  BACKUP_LOCATION: z.string().default('./backups'),
  BACKUP_COMPRESSION: z.string().default('true').transform((v) => v === 'true'),
  BACKUP_INCLUDE_TABLES: z.string().default('all'),

  // Backup Telegram
  BACKUP_TELEGRAM_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  BACKUP_TELEGRAM_CHAT_ID: z.string().optional().default(''),
  BACKUP_TELEGRAM_TOPIC_ID: z.string().optional().default(''),

  // Backup S3
  BACKUP_S3_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  BACKUP_S3_BUCKET: z.string().optional().default(''),
  BACKUP_S3_REGION: z.string().optional().default(''),
  BACKUP_S3_ACCESS_KEY: z.string().optional().default(''),
  BACKUP_S3_SECRET_KEY: z.string().optional().default(''),
  BACKUP_S3_ENDPOINT: z.string().optional().default(''),
});

/**
 * Parsed environment variables type
 */
export type Env = z.infer<typeof envSchema>;

/**
 * Remnawave configuration type
 */
export type RemnawaveEnvConfig = z.infer<typeof _remnawaveSchema>;

/**
 * Database configuration type
 */
export type DatabaseEnvConfig = z.infer<typeof _databaseSchema>;

/**
 * Redis configuration type
 * @deprecated Use ValkeyEnvConfig instead
 */
export type RedisEnvConfig = z.infer<typeof _redisSchema>;

/**
 * Valkey configuration type
 * Note: Valkey is Redis-compatible
 */
export interface ValkeyEnvConfig {
  host: string;
  port: number;
  db: string;
  password: string;
  url: string;
}

/**
 * JWT configuration type
 */
export type JwtEnvConfig = z.infer<typeof _jwtSchema>;

/**
 * Telegram configuration type
 */
export type TelegramEnvConfig = z.infer<typeof _telegramSchema>;

/**
 * Feature flags type
 */
export type FeatureFlags = z.infer<typeof _featureFlagsSchema>;

/**
 * Validate and parse environment variables
 * @returns Parsed environment variables
 * @throws Error if validation fails
 */
export function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Environment validation failed:\n${errors.join('\n')}`);
  }

  return result.data;
}

/**
 * Cached environment variables
 */
let cachedEnv: Env | null = null;

/**
 * Get validated environment variables
 * @returns Environment variables
 */
export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = validateEnv();
  }
  return cachedEnv;
}

/**
 * Get Remnawave configuration from environment
 */
export function getRemnawaveConfig(): RemnawaveEnvConfig {
  const env = getEnv();
  return {
    host: env.REMNAWAVE_HOST,
    port: env.REMNAWAVE_PORT,
    token: env.REMNAWAVE_TOKEN,
    webhookSecret: env.REMNAWAVE_WEBHOOK_SECRET,
    caddyToken: env.REMNAWAVE_CADDY_TOKEN,
    cookie: env.REMNAWAVE_COOKIE,
    syncIntervalMinutes: env.REMNAWAVE_SYNC_INTERVAL_MINUTES,
    syncEnabled: env.REMNAWAVE_SYNC_ENABLED,
  };
}

/**
 * Get Database configuration from environment
 */
export function getDatabaseConfig(): DatabaseEnvConfig {
  const env = getEnv();
  return {
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    name: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    url: env.DATABASE_URL || `postgresql://${env.DATABASE_USER}:${env.DATABASE_PASSWORD}@${env.DATABASE_HOST}:${env.DATABASE_PORT}/${env.DATABASE_NAME}`,
    poolSize: env.DATABASE_POOL_SIZE,
    maxOverflow: env.DATABASE_MAX_OVERFLOW,
    poolTimeout: env.DATABASE_POOL_TIMEOUT,
  };
}

/**
 * Get Valkey configuration from environment
 * Note: Valkey is Redis-compatible, so Redis clients work with Valkey
 */
export function getValkeyConfig(): ValkeyEnvConfig {
  const env = getEnv();
  return {
    host: env.VALKEY_HOST,
    port: env.VALKEY_PORT,
    db: env.VALKEY_DB,
    password: env.VALKEY_PASSWORD,
    url: env.VALKEY_URL || `valkey://${env.VALKEY_HOST}:${env.VALKEY_PORT}/${env.VALKEY_DB}`,
  };
}

/**
 * Get Redis configuration from environment
 * @deprecated Use getValkeyConfig() instead. Kept for backward compatibility.
 */
export function getRedisConfig(): RedisEnvConfig {
  const env = getEnv();
  return {
    host: env.VALKEY_HOST,
    port: env.VALKEY_PORT,
    name: env.VALKEY_DB,
    password: env.VALKEY_PASSWORD,
    url: env.VALKEY_URL || `valkey://${env.VALKEY_HOST}:${env.VALKEY_PORT}/${env.VALKEY_DB}`,
  };
}

/**
 * Get JWT configuration from environment
 */
export function getJwtConfig(): JwtEnvConfig {
  const env = getEnv();
  return {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
    refreshSecret: env.JWT_REFRESH_SECRET,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  };
}

/**
 * Get Telegram configuration from environment
 */
export function getTelegramConfig(): TelegramEnvConfig {
  const env = getEnv();
  return {
    botToken: env.TELEGRAM_BOT_TOKEN,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    miniAppUrl: env.TELEGRAM_MINI_APP_URL,
  };
}

/**
 * Get Super Admin Telegram IDs
 * @returns Array of telegram IDs with full admin access
 */
export function getSuperAdminIds(): string[] {
  const env = getEnv();
  return env.SUPER_ADMIN_TELEGRAM_ID
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);
}

/**
 * Check if telegram ID is a super admin
 * @param telegramId Telegram user ID
 * @returns true if user is super admin
 */
export function isSuperAdmin(telegramId: string | number): boolean {
  const superAdmins = getSuperAdminIds();
  return superAdmins.includes(String(telegramId));
}

/**
 * Get feature flags from environment
 */
export function getFeatureFlags(): FeatureFlags {
  const env = getEnv();
  return {
    paymentsEnabled: env.FEATURE_PAYMENTS_ENABLED,
    referralEnabled: env.FEATURE_REFERRAL_ENABLED,
    partnerEnabled: env.FEATURE_PARTNER_ENABLED,
    websocketEnabled: env.FEATURE_WEBSOCKET_ENABLED,
  };
}

/**
 * Backup configuration type
 */
export interface BackupConfig {
  enabled: boolean;
  intervalHours: number;
  time: string;
  maxKeep: number;
  location: string;
  compression: boolean;
  includeTables: string[];
  telegramEnabled: boolean;
  telegramChatId: string;
  telegramTopicId?: string;
  s3Enabled: boolean;
  s3Bucket?: string;
  s3Region?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Endpoint?: string;
}

/**
 * Get backup configuration from environment
 */
export function getBackupConfig(): BackupConfig {
  const env = getEnv();
  return {
    enabled: env.BACKUP_ENABLED,
    intervalHours: env.BACKUP_INTERVAL_HOURS,
    time: env.BACKUP_TIME,
    maxKeep: env.BACKUP_MAX_KEEP,
    location: env.BACKUP_LOCATION,
    compression: env.BACKUP_COMPRESSION,
    includeTables: env.BACKUP_INCLUDE_TABLES.split(',').map(t => t.trim()),
    telegramEnabled: env.BACKUP_TELEGRAM_ENABLED,
    telegramChatId: env.BACKUP_TELEGRAM_CHAT_ID,
    telegramTopicId: env.BACKUP_TELEGRAM_TOPIC_ID || undefined,
    s3Enabled: env.BACKUP_S3_ENABLED,
    s3Bucket: env.BACKUP_S3_BUCKET || undefined,
    s3Region: env.BACKUP_S3_REGION || undefined,
    s3AccessKey: env.BACKUP_S3_ACCESS_KEY || undefined,
    s3SecretKey: env.BACKUP_S3_SECRET_KEY || undefined,
    s3Endpoint: env.BACKUP_S3_ENDPOINT || undefined,
  };
}

/**
 * Build Remnawave base URL
 */
export function getRemnawaveBaseUrl(): string {
  const config = getRemnawaveConfig();
  const isExternal = config.host !== 'remnawave';
  if (isExternal) {
    return `https://${config.host}`;
  }
  return `http://${config.host}:${config.port}`;
}

/**
 * Build Remnawave API URL
 */
export function getRemnawaveApiUrl(): string {
  return `${getRemnawaveBaseUrl()}/api`;
}

/**
 * Get Remnawave API headers for authentication
 */
export function getRemnawaveHeaders(): Record<string, string> {
  const config = getRemnawaveConfig();
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${config.token}`,
    'Content-Type': 'application/json',
  };

  if (config.caddyToken) {
    headers['X-Api-Key'] = config.caddyToken;
  }

  // For Docker internal connections, add forwarding headers
  if (config.host === 'remnawave') {
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-for'] = '127.0.0.1';
  }

  return headers;
}

/**
 * Parse Remnawave cookie if present
 */
export function getRemnawaveCookies(): Record<string, string> {
  const config = getRemnawaveConfig();
  const cookies: Record<string, string> = {};

  if (config.cookie) {
    const [name, value] = config.cookie.split('=');
    if (name && value) {
      cookies[name.trim()] = value.trim();
    }
  }

  return cookies;
}
