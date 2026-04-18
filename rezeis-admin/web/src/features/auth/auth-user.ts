import { z } from 'zod'

const authUserIdSchema = z.string().min(1, 'errors.unexpectedResponsePayload')
const authDateTimeSchema = z.string().datetime()

export const authUserSchema = z
  .object({
    id: authUserIdSchema,
    login: z.string().trim().min(1, 'errors.unexpectedResponsePayload'),
    email: z.string().nullable(),
    name: z.string().nullable(),
    role: z.string().min(1, 'errors.unexpectedResponsePayload'),
    isActive: z.boolean(),
    tokenVersion: z.number().int(),
    createdAt: authDateTimeSchema,
    lastLoginAt: authDateTimeSchema.nullable(),
    lastLoginIp: z.string().nullable(),
  })
  .strict()

export const authLoginResponseSchema = z
  .object({
    accessToken: z.string().trim().min(1, 'errors.accessTokenMissing'),
    tokenType: z.literal('Bearer'),
    expiresIn: z.string().trim().min(1, 'errors.unexpectedResponsePayload'),
    admin: authUserSchema,
  })
  .strict()

export const authMeResponseSchema = z
  .object({
    admin: authUserSchema,
  })
  .strict()
