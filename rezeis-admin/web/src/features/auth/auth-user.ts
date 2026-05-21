import { z } from 'zod'

/**
 * Shape of the authenticated admin profile returned by `/api/admin/auth/me`
 * and persisted into the auth store. Keep this schema strict — any drift
 * from the backend contract should surface as a parse error rather than a
 * silent shape mismatch in the UI.
 */
export const authUserSchema = z.object({
  id: z.string(),
  login: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  role: z.enum(['DEV', 'ADMIN', 'USER']),
  isActive: z.boolean(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  lastLoginIp: z.string().nullable(),
})

export type AuthUser = z.infer<typeof authUserSchema>
