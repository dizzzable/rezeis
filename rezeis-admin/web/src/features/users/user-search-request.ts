import { z } from 'zod'
import { createUserSearchSchema } from './user-search-schema'

type UserSearchFormValues = z.infer<ReturnType<typeof createUserSearchSchema>>

function normalizeValue(value: string): string | undefined {
  const normalizedValue: string = value.trim()
  return normalizedValue.length > 0 ? normalizedValue : undefined
}

export function buildUserSearchParams(values: UserSearchFormValues): Record<string, string | undefined> {
  return {
    userId: normalizeValue(values.userId),
    telegramId: normalizeValue(values.telegramId),
    email: normalizeValue(values.email),
    login: normalizeValue(values.login),
  }
}
