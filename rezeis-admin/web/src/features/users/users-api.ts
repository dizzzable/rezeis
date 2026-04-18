import { z } from 'zod'
import { api } from '@/lib/api'
import { createUserSearchSchema } from '@/features/users/user-search-schema'
import { buildUserSearchParams } from '@/features/users/user-search-request'

const userSearchResultSchema = z.object({
  session: z.object({
    id: z.string(),
    telegramId: z.string().nullable(),
    username: z.string().nullable(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    role: z.string(),
    language: z.string(),
    personalDiscount: z.number(),
    purchaseDiscount: z.number(),
    points: z.number(),
    maxSubscriptions: z.number(),
    isBlocked: z.boolean(),
    isBotBlocked: z.boolean(),
    isRulesAccepted: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
    webAccount: z
      .object({
        id: z.string(),
        login: z.string().nullable(),
        loginNormalized: z.string().nullable(),
        email: z.string().nullable(),
        emailNormalized: z.string().nullable(),
        emailVerifiedAt: z.string().nullable(),
        requiresPasswordChange: z.boolean(),
        linkPromptSnoozeUntil: z.string().nullable(),
        credentialsBootstrappedAt: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string(),
      })
      .nullable(),
  }),
  subscription: z
    .object({
      id: z.string(),
      status: z.string(),
      isTrial: z.boolean(),
      plan: z
        .object({
          name: z.string().nullable(),
          type: z.string().nullable(),
        })
        .nullable(),
      trafficLimit: z.number().nullable(),
      deviceLimit: z.number(),
      configUrl: z.string().nullable(),
      startedAt: z.string().nullable(),
      expiresAt: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .nullable(),
})

type UserSearchFormValues = z.infer<ReturnType<typeof createUserSearchSchema>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('errors.unexpectedUsersPayload')
  }
  const nestedValue: unknown = value.data
  if (isRecord(nestedValue)) {
    return nestedValue
  }
  return value
}

async function searchUser(values: UserSearchFormValues): Promise<z.infer<typeof userSearchResultSchema>> {
  const response = await api.get('/admin/users/search', {
    params: buildUserSearchParams(values),
  })
  return userSearchResultSchema.parse(unwrapPayload(response.data))
}

export const usersApi = {
  searchUser,
}
