import { z } from 'zod'
import { api } from '@/lib/api'
import { authLoginResponseSchema, authMeResponseSchema, authUserSchema } from '@/features/auth/auth-user'

type AuthUser = z.infer<typeof authUserSchema>
type AuthLoginResponse = z.infer<typeof authLoginResponseSchema>

interface LoginPayload {
  readonly login: string
  readonly password: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapPayload(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Error('errors.unexpectedResponsePayload')
  }
  const nestedValue: unknown = value.data
  if (nestedValue !== undefined) {
    return nestedValue
  }
  return value
}

function parseSchemaValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsedValue = schema.safeParse(value)
  if (!parsedValue.success) {
    throw new Error('errors.unexpectedResponsePayload')
  }
  return parsedValue.data
}

export const authApi = {
  async login(payload: LoginPayload): Promise<AuthLoginResponse> {
    const response = await api.post('/auth/login', payload)
    return parseSchemaValue(authLoginResponseSchema, unwrapPayload(response.data))
  },
  async getMe(): Promise<AuthUser> {
    const response = await api.get('/auth/me')
    return parseSchemaValue(authMeResponseSchema, unwrapPayload(response.data)).admin
  },
}
