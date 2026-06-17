import { z } from 'zod'
import { api } from '@/lib/api'

const backupManifestSchema = z.object({
  generatedAt: z.string(),
  exportEnabled: z.literal(false),
  restoreEnabled: z.literal(false),
  domains: z.array(z.object({
    domain: z.string(),
    status: z.enum(['READY_FOR_EXPORT_DESIGN', 'REQUIRES_RESTORE_DESIGN']),
    rowCount: z.number(),
    containsSensitiveData: z.boolean(),
    notes: z.array(z.string()),
  })),
})

const backupManifestResponseSchema = z.object({ data: backupManifestSchema })
const backupExportPolicySchema = z.object({
  generatedAt: z.string(),
  exportEndpointEnabled: z.literal(false),
  restoreEnabled: z.literal(false),
  domains: z.array(z.object({
    domain: z.string(),
    exportAllowed: z.boolean(),
    includedFields: z.array(z.string()),
    redactedFields: z.array(z.string()),
    notes: z.array(z.string()),
  })),
})
const backupExportPolicyResponseSchema = z.object({ data: backupExportPolicySchema })
const backupImportsExportSchema = z.object({
  generatedAt: z.string(),
  domain: z.literal('imports'),
  restoreEnabled: z.literal(false),
  rawContentIncluded: z.literal(false),
  batches: z.array(z.object({
    id: z.string(),
    sourceType: z.string(),
    status: z.string(),
    totalRows: z.number(),
    acceptedRows: z.number(),
    rejectedRows: z.number(),
    writesPerformed: z.boolean(),
    createdAt: z.string(),
    stagingRows: z.array(z.object({
      rowNumber: z.number(),
      status: z.string(),
      fields: z.array(z.string()),
      identifierKeys: z.array(z.string()),
      errors: z.array(z.string()),
    })),
    rollbackItems: z.array(z.object({
      userId: z.string(),
      email: z.string(),
      status: z.string(),
      rolledBackAt: z.string().nullable(),
    })),
  })),
})
const backupImportsExportResponseSchema = z.object({ data: backupImportsExportSchema })
const backupExportAuditHistorySchema = z.object({
  generatedAt: z.string(),
  items: z.array(z.object({
    id: z.string(),
    action: z.string(),
    adminActorPresent: z.boolean(),
    domain: z.string(),
    batches: z.number(),
    rawContentIncluded: z.boolean(),
    restoreEnabled: z.boolean(),
    createdAt: z.string(),
  })),
})
const backupExportAuditHistoryResponseSchema = z.object({ data: backupExportAuditHistorySchema })
const backupRestorePolicySchema = z.object({
  generatedAt: z.string(),
  restoreEnabled: z.literal(false),
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
  requiredFutureSlices: z.array(z.string()),
})
const backupRestorePolicyResponseSchema = z.object({ data: backupRestorePolicySchema })
const backupRestoreDryRunSchema = z.object({
  domain: z.literal('imports'),
  writesPerformed: z.literal(false),
  isValid: z.boolean(),
  batches: z.number(),
  stagingRows: z.number(),
  rollbackItems: z.number(),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
})
const backupRestoreBatchSchema = z.object({
  id: z.string(),
  domain: z.literal('imports'),
  status: z.string(),
  isValid: z.boolean(),
  batchCount: z.number(),
  stagingRowCount: z.number(),
  rollbackItemCount: z.number(),
  writesPerformed: z.literal(false),
  createdAt: z.string(),
})
const backupPersistedRestoreDryRunResponseSchema = z.object({ data: z.object({ batch: backupRestoreBatchSchema, result: backupRestoreDryRunSchema }) })
const backupRestoreBatchesResponseSchema = z.object({ data: z.array(backupRestoreBatchSchema) })
const backupRestoreBatchDetailSchema = backupRestoreBatchSchema.extend({ errors: z.array(z.object({ code: z.string(), message: z.string() })) })
const backupRestoreBatchDetailResponseSchema = z.object({ data: backupRestoreBatchDetailSchema })
const backupRestoreCommitReadinessSchema = z.object({
  batchId: z.string(),
  isReady: z.boolean(),
  commitEnabled: z.literal(false),
  checks: z.array(z.object({ code: z.string(), passed: z.boolean(), severity: z.enum(['INFO', 'WARNING', 'BLOCKER']), message: z.string() })),
})
const backupRestoreCommitReadinessResponseSchema = z.object({ data: backupRestoreCommitReadinessSchema })
const backupRestoreExecutorGateSchema = z.object({
  generatedAt: z.string(),
  executorEnabled: z.literal(false),
  domains: z.array(z.object({
    domain: z.string(),
    firstSupportedTarget: z.string(),
    blockers: z.array(z.string()),
    requiredControls: z.array(z.string()),
  })),
})
const backupRestoreExecutorGateResponseSchema = z.object({ data: backupRestoreExecutorGateSchema })

export type BackupManifest = z.infer<typeof backupManifestSchema>
export type BackupExportPolicy = z.infer<typeof backupExportPolicySchema>
export type BackupImportsExport = z.infer<typeof backupImportsExportSchema>
export type BackupExportAuditHistory = z.infer<typeof backupExportAuditHistorySchema>
export type BackupRestorePolicy = z.infer<typeof backupRestorePolicySchema>
export type BackupRestoreDryRun = z.infer<typeof backupRestoreDryRunSchema>
export type BackupRestoreBatch = z.infer<typeof backupRestoreBatchSchema>
export type BackupRestoreBatchDetail = z.infer<typeof backupRestoreBatchDetailSchema>
export type BackupRestoreCommitReadiness = z.infer<typeof backupRestoreCommitReadinessSchema>
export type BackupRestoreExecutorGate = z.infer<typeof backupRestoreExecutorGateSchema>

export async function getBackupManifest(): Promise<BackupManifest> {
  const response = await api.get('/admin/backup/manifest')
  return backupManifestResponseSchema.parse(response.data).data
}

export async function getBackupExportPolicy(): Promise<BackupExportPolicy> {
  const response = await api.get('/admin/backup/export-policy')
  return backupExportPolicyResponseSchema.parse(response.data).data
}

export async function exportBackupImports(): Promise<BackupImportsExport> {
  const response = await api.get('/admin/backup/exports/imports')
  return backupImportsExportResponseSchema.parse(response.data).data
}

export async function downloadBackupImports(): Promise<Blob> {
  const response = await api.get('/admin/backup/exports/imports/download', { responseType: 'blob' })
  return response.data as Blob
}

export async function listBackupExportAudits(): Promise<BackupExportAuditHistory> {
  const response = await api.get('/admin/backup/export-audits')
  return backupExportAuditHistoryResponseSchema.parse(response.data).data
}

export async function getBackupRestorePolicy(): Promise<BackupRestorePolicy> {
  const response = await api.get('/admin/backup/restore-policy')
  return backupRestorePolicyResponseSchema.parse(response.data).data
}

export async function dryRunRestoreImports(content: string): Promise<BackupRestoreDryRun> {
  const response = await api.post('/admin/backup/restore/imports/dry-run', { content })
  return backupPersistedRestoreDryRunResponseSchema.parse(response.data).data.result
}

export async function listRestoreBatches(): Promise<readonly BackupRestoreBatch[]> {
  const response = await api.get('/admin/backup/restore/imports/batches')
  return backupRestoreBatchesResponseSchema.parse(response.data).data
}

export async function getRestoreBatch(batchId: string): Promise<BackupRestoreBatchDetail> {
  const response = await api.get(`/admin/backup/restore/imports/batches/${encodeURIComponent(batchId)}`)
  return backupRestoreBatchDetailResponseSchema.parse(response.data).data
}

export async function getRestoreCommitReadiness(batchId: string): Promise<BackupRestoreCommitReadiness> {
  const response = await api.get(`/admin/backup/restore/imports/batches/${encodeURIComponent(batchId)}/commit-readiness`)
  return backupRestoreCommitReadinessResponseSchema.parse(response.data).data
}

export async function getRestoreExecutorGate(): Promise<BackupRestoreExecutorGate> {
  const response = await api.get('/admin/backup/restore/executor-gate')
  return backupRestoreExecutorGateResponseSchema.parse(response.data).data
}

// ── Backup settings (schedule + Telegram delivery) ───────────────────────────

const backupSettingsSchema = z.object({
  autoEnabled: z.boolean(),
  intervalHours: z.number(),
  maxKeep: z.number(),
  telegram: z.object({
    enabled: z.boolean(),
    chatId: z.string().nullable(),
    topicId: z.number().nullable(),
  }),
  botTokenConfigured: z.boolean(),
})
export type BackupSettings = z.infer<typeof backupSettingsSchema>

export interface SaveBackupSettingsPayload {
  autoEnabled?: boolean
  intervalHours?: number
  maxKeep?: number
  telegram?: { enabled?: boolean; chatId?: string | null; topicId?: string | null }
}

export async function getBackupSettings(): Promise<BackupSettings> {
  const response = await api.get('/admin/backup/settings')
  return backupSettingsSchema.parse(response.data)
}

export async function saveBackupSettings(payload: SaveBackupSettingsPayload): Promise<BackupSettings> {
  const response = await api.patch('/admin/backup/settings', payload)
  return backupSettingsSchema.parse(response.data)
}

export const backupApi = { getManifest: getBackupManifest, getExportPolicy: getBackupExportPolicy, exportImports: exportBackupImports, downloadImports: downloadBackupImports, listExportAudits: listBackupExportAudits, getRestorePolicy: getBackupRestorePolicy, dryRunRestoreImports, listRestoreBatches, getRestoreBatch, getRestoreCommitReadiness, getRestoreExecutorGate, getBackupSettings, saveBackupSettings }
