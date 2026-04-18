import { z } from 'zod'

const EMAIL_LOOKUP_PATTERN: RegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LOGIN_LOOKUP_PATTERN: RegExp = /^[A-Za-z0-9._-]+$/
const TELEGRAM_ID_PATTERN: RegExp = /^\d+$/
const UUID_PATTERN: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOGIN_MIN_LENGTH: number = 3
const LOGIN_MAX_LENGTH: number = 64

function trimValue(value: string): string {
  return value.trim()
}

function isEmptyValue(value: string): boolean {
  return trimValue(value).length === 0
}

function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(trimValue(value))
}

function isValidTelegramId(value: string): boolean {
  return TELEGRAM_ID_PATTERN.test(trimValue(value))
}

function isValidEmail(value: string): boolean {
  return EMAIL_LOOKUP_PATTERN.test(trimValue(value))
}

function isValidLogin(value: string): boolean {
  const normalizedValue: string = trimValue(value)
  return normalizedValue.length >= LOGIN_MIN_LENGTH && normalizedValue.length <= LOGIN_MAX_LENGTH && LOGIN_LOOKUP_PATTERN.test(normalizedValue)
}

export function createUserSearchSchema() {
  return z
    .object({
      userId: z
        .string()
        .refine((value: string): boolean => isEmptyValue(value) || isValidUuid(value), 'users.searchPage.form.errors.userIdInvalid'),
      telegramId: z
        .string()
        .refine((value: string): boolean => isEmptyValue(value) || isValidTelegramId(value), 'users.searchPage.form.errors.telegramIdInvalid'),
      email: z
        .string()
        .refine((value: string): boolean => isEmptyValue(value) || isValidEmail(value), 'users.searchPage.form.errors.emailInvalid')
        .refine((value: string): boolean => isEmptyValue(value) || trimValue(value).length <= 320, 'users.searchPage.form.errors.emailTooLong'),
      login: z
        .string()
        .refine((value: string): boolean => isEmptyValue(value) || isValidLogin(value), 'users.searchPage.form.errors.loginInvalid'),
    })
    .superRefine((values, ctx): void => {
      const identifierCount: number = [values.userId, values.telegramId, values.email, values.login].filter((value: string): boolean => !isEmptyValue(value)).length
      if (identifierCount === 1) {
        return
      }
      ctx.addIssue({
        code: 'custom',
        path: ['userId'],
        message: 'users.searchPage.form.errors.exactlyOneIdentifier',
      })
      ctx.addIssue({
        code: 'custom',
        path: ['telegramId'],
        message: 'users.searchPage.form.errors.exactlyOneIdentifier',
      })
      ctx.addIssue({
        code: 'custom',
        path: ['email'],
        message: 'users.searchPage.form.errors.exactlyOneIdentifier',
      })
      ctx.addIssue({
        code: 'custom',
        path: ['login'],
        message: 'users.searchPage.form.errors.exactlyOneIdentifier',
      })
    })
}
