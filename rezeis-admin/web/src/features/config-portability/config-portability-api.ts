import { api } from '@/lib/api'

export type ConfigSection =
  | 'roles'
  | 'permissions'
  | 'scopePolicies'
  | 'automations'
  | 'webhooks'
  | 'notificationTemplates'
  | 'settings'
  | 'blockedIps'
  | 'adminIpAllowlist'
  | 'faqItems'

export type ImportStrategy = 'skip' | 'overwrite'

export interface ConfigExportPayload {
  version: number
  exportedAt: string
  source: 'rezeis-admin'
  sections: Partial<Record<ConfigSection, unknown[]>>
}

export interface ConfigImportSummary {
  section: ConfigSection
  created: number
  updated: number
  skipped: number
  errors: readonly string[]
}

export interface ConfigImportResult {
  version: number
  strategy: ImportStrategy
  dryRun: boolean
  summaries: readonly ConfigImportSummary[]
  startedAt: string
  finishedAt: string
}

export async function listConfigSections(): Promise<readonly ConfigSection[]> {
  const response = await api.get<{ sections: readonly ConfigSection[] }>('/admin/config/sections')
  return response.data.sections
}

export async function exportConfig(
  sections: readonly ConfigSection[] | null,
): Promise<ConfigExportPayload> {
  const params = new URLSearchParams()
  if (sections && sections.length > 0) {
    for (const s of sections) params.append('sections', s)
  }
  const qs = params.toString()
  const response = await api.get<ConfigExportPayload>(
    `/admin/config/export${qs ? `?${qs}` : ''}`,
  )
  return response.data
}

export async function importConfig(input: {
  payload: ConfigExportPayload
  sections: readonly ConfigSection[] | null
  strategy: ImportStrategy
  dryRun: boolean
}): Promise<ConfigImportResult> {
  const response = await api.post<ConfigImportResult>('/admin/config/import', {
    payload: input.payload,
    sections: input.sections ?? undefined,
    strategy: input.strategy,
    dryRun: input.dryRun,
  })
  return response.data
}
