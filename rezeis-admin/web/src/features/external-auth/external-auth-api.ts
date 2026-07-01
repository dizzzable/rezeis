import { z } from 'zod'

import { api } from '@/lib/api'

export const EXTERNAL_PROVIDERS = ['TELEGRAM', 'GOOGLE', 'YANDEX', 'MAILRU'] as const
export type ExternalProvider = (typeof EXTERNAL_PROVIDERS)[number]

export const DISPOSABLE_MODES = ['off', 'blocklist', 'blocklist_mx', 'allowlist'] as const
export type DisposableMode = (typeof DISPOSABLE_MODES)[number]

const providerConfigSchema = z.object({
  provider: z.enum(EXTERNAL_PROVIDERS),
  isEnabled: z.boolean(),
  displayName: z.string(),
  clientId: z.string().nullable(),
  hasSecret: z.boolean(),
  usePkce: z.boolean(),
  scopes: z.string().nullable(),
  usesBotToken: z.boolean(),
  useOidc: z.boolean(),
})
export type ExternalProviderConfig = z.infer<typeof providerConfigSchema>

const policySchema = z.object({
  mode: z.enum(DISPOSABLE_MODES),
  customBlocklist: z.array(z.string()),
  allowlist: z.array(z.string()),
  gateProvidersByEmailModule: z.boolean(),
})
export type ExternalAuthPolicy = z.infer<typeof policySchema>

export interface UpdateProviderInput {
  readonly isEnabled?: boolean
  readonly displayName?: string
  readonly clientId?: string | null
  readonly clientSecret?: string | null
  readonly usePkce?: boolean
  readonly useOidc?: boolean
  readonly scopes?: string | null
}

export const externalAuthApi = {
  async listProviders(): Promise<ExternalProviderConfig[]> {
    const res = await api.get('/admin/external-auth/providers')
    return z.array(providerConfigSchema).parse(res.data)
  },

  async updateProvider(provider: ExternalProvider, input: UpdateProviderInput): Promise<ExternalProviderConfig> {
    const res = await api.put(`/admin/external-auth/providers/${provider}`, input)
    return providerConfigSchema.parse(res.data)
  },

  async getPolicy(): Promise<ExternalAuthPolicy> {
    const res = await api.get('/admin/external-auth/policy')
    return policySchema.parse(res.data)
  },

  async updatePolicy(input: Partial<ExternalAuthPolicy>): Promise<ExternalAuthPolicy> {
    const res = await api.put('/admin/external-auth/policy', input)
    return policySchema.parse(res.data)
  },
}
