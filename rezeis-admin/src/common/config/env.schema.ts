import { z } from 'zod';

import { DEFAULT_SMTP_TIMEOUT_MS } from './email.constants';

const SMTP_IDENTITY_DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1F\x7F]/;

const normalizeOptionalString = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  const normalizedValue = value.trim();
  return normalizedValue === '' ? undefined : normalizedValue;
};

const normalizeRequiredString = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  return value.trim();
};

const smtpIdentityDomainSchema = z
  .string()
  .min(1)
  .regex(SMTP_IDENTITY_DOMAIN_PATTERN, 'REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN must be a valid hostname');

const smtpFromNameSchema = z
  .string()
  .min(1)
  .refine(
    (value): boolean => !CONTROL_CHARACTER_PATTERN.test(value),
    'REZEIS_ADMIN_SMTP_FROM_NAME must not contain control characters',
  );

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REZEIS_ADMIN_CORS_ORIGIN: z.string().url().default('http://localhost:3000'),
  REZEIS_ADMIN_JWT_SECRET: z.string().min(1),
  REZEIS_ADMIN_JWT_EXPIRES_IN: z.string().min(1).default('12h'),
  REZEIS_ADMIN_INTERNAL_API_KEY: z.string().min(1),
  REZEIS_ADMIN_SMTP_HOST: z.preprocess(normalizeRequiredString, z.string().min(1)),
  REZEIS_ADMIN_SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  REZEIS_ADMIN_SMTP_SECURE: z.preprocess(
    normalizeRequiredString,
    z.enum(['true', 'false']).transform((value): boolean => value === 'true'),
  ),
  REZEIS_ADMIN_SMTP_USER: z.preprocess(normalizeOptionalString, z.string().min(1).optional()),
  REZEIS_ADMIN_SMTP_PASSWORD: z.preprocess(
    normalizeOptionalString,
    z.string().min(1).optional(),
  ),
  REZEIS_ADMIN_SMTP_FROM_ADDRESS: z.preprocess(normalizeRequiredString, z.string().email()),
  REZEIS_ADMIN_SMTP_FROM_NAME: z.preprocess(normalizeRequiredString, smtpFromNameSchema),
  REZEIS_ADMIN_SMTP_REPLY_TO: z.preprocess(
    normalizeOptionalString,
    z.string().email().optional(),
  ),
  REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN: z.preprocess(
    normalizeOptionalString,
    smtpIdentityDomainSchema.optional(),
  ),
  REZEIS_ADMIN_SMTP_TIMEOUT_MS: z.coerce.number().int().min(1).default(DEFAULT_SMTP_TIMEOUT_MS),
}).superRefine((environmentVariables, refinementContext): void => {
  const hasUser = environmentVariables.REZEIS_ADMIN_SMTP_USER !== undefined;
  const hasPassword = environmentVariables.REZEIS_ADMIN_SMTP_PASSWORD !== undefined;
  if (hasUser === hasPassword) {
    return;
  }
  refinementContext.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'REZEIS_ADMIN_SMTP_USER and REZEIS_ADMIN_SMTP_PASSWORD must be provided together',
    path: ['REZEIS_ADMIN_SMTP_USER'],
  });
});

/**
 * Validates and normalizes process environment variables.
 */
export function validateEnvironment(
  environmentVariables: Record<string, unknown>,
): Record<string, unknown> {
  return environmentSchema.parse(environmentVariables);
}
