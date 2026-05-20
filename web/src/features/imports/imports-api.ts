import { z } from 'zod'
import { api } from '@/lib/api'

const importSourceTypeSchema = z.enum(['CSV', 'JSON'])

const importDryRunResultSchema = z.object({
  sourceType: importSourceTypeSchema,
  totalRows: z.number(),
  acceptedRows: z.number(),
  rejectedRows: z.number(),
  validationErrors: z.array(z.object({
    rowNumber: z.number(),
    code: z.string(),
    message: z.string(),
  })),
  previewRows: z.array(z.object({
    rowNumber: z.number(),
    fields: z.array(z.string()),
    identifierPresent: z.boolean(),
  })),
  writesPerformed: z.boolean(),
  target: z.string().optional(),
  createdUsers: z.number().optional(),
  skippedExistingUsers: z.number().optional(),
  skippedRows: z.number().optional(),
})

const importBatchSchema = z.object({
  id: z.string(),
  adminUserId: z.string().nullable(),
  sourceType: z.string(),
  status: z.string(),
  totalRows: z.number(),
  acceptedRows: z.number(),
  rejectedRows: z.number(),
  writesPerformed: z.boolean(),
  target: z.string().optional(),
  createdUsers: z.number().optional(),
  skippedExistingUsers: z.number().optional(),
  skippedRows: z.number().optional(),
  createdAt: z.string(),
})

const importDryRunResponseSchema = z.object({ data: z.object({ batch: importBatchSchema, result: importDryRunResultSchema }) })
const importBatchesResponseSchema = z.object({ data: z.array(importBatchSchema) })
const importBatchDetailSchema = importBatchSchema.extend({
  validationErrors: importDryRunResultSchema.shape.validationErrors,
  previewRows: importDryRunResultSchema.shape.previewRows,
  stagingRows: z.array(z.object({
    rowNumber: z.number(),
    status: z.string(),
    identifiers: z.record(z.string(), z.string()),
    fields: z.array(z.string()),
    errors: z.array(z.string()),
  })),
})
const importBatchDetailResponseSchema = z.object({ data: importBatchDetailSchema })
const importCommitReadinessSchema = z.object({
  batchId: z.string(),
  isReady: z.boolean(),
  checks: z.array(z.object({
    code: z.string(),
    passed: z.boolean(),
    message: z.string(),
  })),
  commitEnabled: z.boolean(),
  reason: z.string(),
})
const importCommitReadinessResponseSchema = z.object({ data: importCommitReadinessSchema })
const importRollbackReadinessSchema = z.object({
  batchId: z.string(),
  isReady: z.boolean(),
  rollbackEnabled: z.boolean(),
  checks: z.array(z.object({
    code: z.string(),
    passed: z.boolean(),
    message: z.string(),
  })),
  reason: z.string(),
})
const importRollbackReadinessResponseSchema = z.object({ data: importRollbackReadinessSchema })
const importCommitSchema = z.object({
  batchId: z.string(),
  status: z.string(),
  committed: z.boolean(),
  writesPerformed: z.boolean(),
  target: z.string().optional(),
  createdUsers: z.number().optional(),
  skippedExistingUsers: z.number().optional(),
  skippedRows: z.number().optional(),
  checkedAt: z.string(),
})
const importCommitResponseSchema = z.object({ data: importCommitSchema })
const importRollbackSchema = z.object({
  batchId: z.string(),
  status: z.string(),
  rolledBack: z.boolean(),
  deletedUsers: z.number(),
  checkedAt: z.string(),
})
const importRollbackResponseSchema = z.object({ data: importRollbackSchema })

export type ImportSourceType = z.infer<typeof importSourceTypeSchema>
export type ImportDryRunResult = z.infer<typeof importDryRunResultSchema>
export type ImportBatch = z.infer<typeof importBatchSchema>
export type ImportBatchDetail = z.infer<typeof importBatchDetailSchema>
export type ImportCommitReadiness = z.infer<typeof importCommitReadinessSchema>
export type ImportCommit = z.infer<typeof importCommitSchema>
export type ImportRollbackReadiness = z.infer<typeof importRollbackReadinessSchema>
export type ImportRollback = z.infer<typeof importRollbackSchema>

export async function dryRunImport(input: {
  readonly sourceType: ImportSourceType
  readonly content: string
}): Promise<{ readonly batch: ImportBatch; readonly result: ImportDryRunResult }> {
  const response = await api.post('/admin/imports/dry-run', input)
  return importDryRunResponseSchema.parse(response.data).data
}

export async function listImportBatches(): Promise<readonly ImportBatch[]> {
  const response = await api.get('/admin/imports/batches')
  return importBatchesResponseSchema.parse(response.data).data
}

export async function getImportBatch(batchId: string): Promise<ImportBatchDetail> {
  const response = await api.get(`/admin/imports/batches/${encodeURIComponent(batchId)}`)
  return importBatchDetailResponseSchema.parse(response.data).data
}

export async function getImportCommitReadiness(batchId: string): Promise<ImportCommitReadiness> {
  const response = await api.get(`/admin/imports/batches/${encodeURIComponent(batchId)}/commit-readiness`)
  return importCommitReadinessResponseSchema.parse(response.data).data
}

export async function commitImportBatch(batchId: string, target: 'STAGING_LOCK' | 'CREATE_EMAIL_USERS' = 'STAGING_LOCK'): Promise<ImportCommit> {
  const response = await api.post(`/admin/imports/batches/${encodeURIComponent(batchId)}/commit`, { target })
  return importCommitResponseSchema.parse(response.data).data
}

export async function getImportRollbackReadiness(batchId: string): Promise<ImportRollbackReadiness> {
  const response = await api.get(`/admin/imports/batches/${encodeURIComponent(batchId)}/rollback-readiness`)
  return importRollbackReadinessResponseSchema.parse(response.data).data
}

export async function rollbackImportBatch(batchId: string): Promise<ImportRollback> {
  const response = await api.post(`/admin/imports/batches/${encodeURIComponent(batchId)}/rollback`)
  return importRollbackResponseSchema.parse(response.data).data
}

export const importsApi = {
  dryRun: dryRunImport,
  listBatches: listImportBatches,
  getBatch: getImportBatch,
  getCommitReadiness: getImportCommitReadiness,
  getRollbackReadiness: getImportRollbackReadiness,
  commitBatch: commitImportBatch,
  rollbackBatch: rollbackImportBatch,
}
