import { z } from 'zod';

/**
 * Backup status enum schema
 */
export const backupStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed']);

/**
 * Backup type enum schema
 */
export const backupTypeSchema = z.enum(['manual', 'scheduled']);

/**
 * Backup schedule enum schema
 */
export const backupScheduleSchema = z.enum(['daily', 'weekly']);

/**
 * Backup schema
 */
export const backupSchema = z.object({
  id: z.string(),
  filename: z.string(),
  size: z.number(),
  status: backupStatusSchema,
  type: backupTypeSchema,
  createdAt: z.string(),
  completedAt: z.string().optional(),
  errorMessage: z.string().optional(),
});

/**
 * Create backup schema
 */
export const createBackupSchema = z.object({
  type: backupTypeSchema.default('manual'),
});

/**
 * Backup config schema
 */
export const backupConfigSchema = z.object({
  id: z.string(),
  isEnabled: z.boolean(),
  schedule: backupScheduleSchema,
  backupTime: z.string(), // Format: "HH:mm"
  retentionCount: z.number(),
  updatedAt: z.string(),
});

/**
 * Update backup config schema
 */
export const updateBackupConfigSchema = z.object({
  isEnabled: z.boolean().optional(),
  schedule: backupScheduleSchema.optional(),
  backupTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format, expected HH:mm').optional(),
  retentionCount: z.number().min(1).max(30).optional(),
});

/**
 * Get backups query schema
 */
export const getBackupsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  status: backupStatusSchema.optional(),
  type: backupTypeSchema.optional(),
});

/**
 * Backup params schema (for routes with ID)
 */
export const backupParamsSchema = z.object({
  id: z.string(),
});

/**
 * Paginated backups response schema
 */
export const paginatedBackupsResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    data: z.array(backupSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
  }),
  message: z.string().optional(),
});

/**
 * Backup response wrapper schema
 */
export const backupResponseSchema = z.object({
  success: z.boolean(),
  data: backupSchema,
  message: z.string().optional(),
});

/**
 * Backup config response schema
 */
export const backupConfigResponseSchema = z.object({
  success: z.boolean(),
  data: backupConfigSchema,
  message: z.string().optional(),
});

/**
 * Delete backup response schema
 */
export const deleteBackupResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

/**
 * Error response schema
 */
export const errorResponseSchema = z.object({
  success: z.boolean().optional(),
  error: z.string(),
});

/**
 * Type definitions
 */
export type BackupResponse = z.infer<typeof backupSchema>;
export type BackupStatus = z.infer<typeof backupStatusSchema>;
export type BackupType = z.infer<typeof backupTypeSchema>;
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;
export type BackupConfigResponse = z.infer<typeof backupConfigSchema>;
export type CreateBackupInput = z.infer<typeof createBackupSchema>;
export type UpdateBackupConfigInput = z.infer<typeof updateBackupConfigSchema>;
export type GetBackupsQuery = z.infer<typeof getBackupsQuerySchema>;
export type BackupParams = z.infer<typeof backupParamsSchema>;
