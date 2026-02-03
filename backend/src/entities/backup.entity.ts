/**
 * Backup status enum
 */
export type BackupStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Backup type enum
 */
export type BackupType = 'manual' | 'scheduled';

/**
 * Backup schedule enum
 */
export type BackupSchedule = 'daily' | 'weekly';

/**
 * Backup entity interface
 */
export interface Backup {
  id: string;
  filename: string;
  size: number;
  status: BackupStatus;
  type: BackupType;
  createdAt: Date;
  completedAt?: Date;
  errorMessage?: string;
}

/**
 * Create backup DTO
 */
export type CreateBackupDTO = Omit<Backup, 'id' | 'createdAt' | 'completedAt'>;

/**
 * Update backup DTO
 */
export type UpdateBackupDTO = Partial<Omit<Backup, 'id' | 'createdAt'>>;

/**
 * Backup filters for pagination
 */
export interface BackupFilters {
  status?: BackupStatus;
  type?: BackupType;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Backup config entity interface
 */
export interface BackupConfig {
  id: string;
  isEnabled: boolean;
  schedule: BackupSchedule;
  backupTime: string; // Format: "HH:mm" (24-hour)
  retentionCount: number;
  updatedAt: Date;
}

/**
 * Create backup config DTO
 */
export type CreateBackupConfigDTO = Omit<BackupConfig, 'id' | 'updatedAt'>;

/**
 * Update backup config DTO
 */
export type UpdateBackupConfigDTO = Partial<Omit<BackupConfig, 'id' | 'updatedAt'>>;
