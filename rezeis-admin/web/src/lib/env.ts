interface EnvConfig {
  readonly adminApiUrl: string
}

function normalizeApiUrl(value: string | undefined): string {
  const fallbackValue: string = 'http://localhost:3100/api'
  const normalizedValue: string = (value ?? fallbackValue).trim()
  return normalizedValue.replace(/\/$/, '')
}

export const env: EnvConfig = {
  adminApiUrl: normalizeApiUrl((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_ADMIN_API_URL),
}
