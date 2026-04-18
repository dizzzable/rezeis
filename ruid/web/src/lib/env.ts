import { z } from 'zod'

const envSchema = z.object({
  VITE_RUID_API_URL: z.string().min(1).optional(),
})

const parsedEnv = envSchema.safeParse(import.meta.env)

if (!parsedEnv.success) {
  throw new Error('Invalid web environment configuration.')
}

function resolveRuidApiUrl(value: string | undefined): string {
  if (value === undefined) {
    return '/api/v1'
  }
  if (value.startsWith('/')) {
    return value
  }
  try {
    return new URL(value).toString().replace(/\/$/, '')
  } catch {
    throw new Error('VITE_RUID_API_URL must be an absolute URL or a same-origin path.')
  }
}

export const env = {
  ruidApiUrl: resolveRuidApiUrl(parsedEnv.data.VITE_RUID_API_URL),
} as const
