import { api } from '@/lib/api'
import { expectArray, unwrapPayload } from '@/lib/api-utils'

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
  | 'legalDocuments'

export type ImportStrategy = 'skip' | 'overwrite'

export interface ConfigExportPayload {
  version: number
  exportedAt: string
  source: 'rezeis-admin'
  /**
   * Row count the export observed per section. Absent on files written
   * before the manifest existed — the import reports those as
   * `unverifiable` rather than pretending it checked them.
   */
  manifest?: Partial<Record<ConfigSection, number>>
  sections: Partial<Record<ConfigSection, unknown[]>>
}

/**
 * What happened to a section. `created: 0, updated: 0, errors: []` used
 * to be the answer both for "this section imported cleanly and held no
 * rows" and for "this section was never in the file", which is how a
 * restore of a truncated backup read as ten green rows.
 */
export type SectionImportStatus = 'imported' | 'missing' | 'rejected' | 'failed'

export type PayloadIntegrityStatus = 'verified' | 'unverifiable' | 'violated'

export interface ConfigImportSummary {
  section: ConfigSection
  status: SectionImportStatus
  created: number
  updated: number
  skipped: number
  errors: readonly string[]
}

export interface ConfigImportResult {
  version: number
  strategy: ImportStrategy
  dryRun: boolean
  integrity: PayloadIntegrityStatus
  summaries: readonly ConfigImportSummary[]
  startedAt: string
  finishedAt: string
}

export async function listConfigSections(): Promise<readonly ConfigSection[]> {
  const response = await api.get('/admin/config/sections')
  // Nested: on a `{}` body the outer value is fine and `.sections` is
  // `undefined`, so the check belongs on the value actually returned.
  return expectArray<ConfigSection>(unwrapPayload(response.data).sections)
}

export interface ConfigExportOptions {
  /**
   * Ask the API to keep `webhooks.secret` in the file.
   *
   * The export redacts signing secrets by default and the API has always kept
   * a deliberate opt-in for the one case that needs them — promoting a config
   * to another deployment, where the receivers must go on validating existing
   * signatures (`admin-config-portability.controller.ts:79`,
   * `config-export.service.ts:124`). Nothing in the panel ever sent it, so the
   * capability existed with no caller and the migration it was kept for could
   * only be completed by hand-crafting the request.
   *
   * Sent ONLY when true. The API parses the flag as text
   * (`config-import.dto.ts:35` accepts `'true'` / `'1'`), and omitting the
   * parameter — rather than sending `false` — keeps "did not ask" visible in
   * the request itself and in the export audit row.
   */
  readonly includeWebhookSecrets?: boolean
}

export async function exportConfig(
  sections: readonly ConfigSection[] | null,
  options: ConfigExportOptions = {},
): Promise<ConfigExportPayload> {
  const params = new URLSearchParams()
  if (sections && sections.length > 0) {
    for (const s of sections) params.append('sections', s)
  }
  if (options.includeWebhookSecrets === true) {
    params.set('includeWebhookSecrets', 'true')
  }
  const qs = params.toString()
  const response = await api.get<ConfigExportPayload>(
    `/admin/config/export${qs ? `?${qs}` : ''}`,
  )
  return response.data
}

/**
 * How many `webhooks` rows in a picked file carry no signing secret.
 *
 * `WebhookSubscription.secret` is a non-nullable `String` with no default
 * (see `model WebhookSubscription` in `prisma/schema.prisma`), so a row the
 * destination does not already hold cannot be CREATED without it —
 * `upsertById` takes the `create` arm and Prisma refuses. A row that already
 * exists is fine: the update arm writes
 * only the columns the payload carries, which is exactly why the redaction
 * omits a secret instead of blanking it.
 *
 * The panel already has the parsed file in hand, so this is read off what is
 * there rather than being a new signal anyone has to produce.
 */
export function countWebhookRowsMissingSecret(payload: ConfigExportPayload): number {
  const rows = payload.sections?.webhooks
  if (!Array.isArray(rows)) return 0
  return rows.filter(
    (row) =>
      typeof row === 'object'
      && row !== null
      && !Array.isArray(row)
      && typeof (row as Record<string, unknown>)['secret'] !== 'string',
  ).length
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
