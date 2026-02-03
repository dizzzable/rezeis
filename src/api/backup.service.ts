import apiClient from './client';

/**
 * Backup API service
 * Handles all API calls related to backup management
 */

export interface BackupFile {
  filename: string;
  size: number;
  createdAt: Date;
  tables: string[];
  recordCount: number;
  compressed: boolean;
}

export interface BackupConfig {
  enabled: boolean;
  intervalHours: number;
  time: string;
  maxKeep: number;
  location: string;
  compression: boolean;
  includeTables: string[];
  telegramEnabled: boolean;
  telegramChatId: string | null;
  s3Enabled: boolean;
  s3Bucket?: string;
}

export interface BackupStats {
  totalBackups: number;
  totalSize: number;
  oldestBackup: Date | null;
  latestBackup: Date | null;
}

export interface CreateBackupInput {
  tables?: string[];
  name?: string;
  description?: string;
}

export interface RestoreBackupInput {
  mode: 'merge' | 'clear';
  tables?: string[];
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

/**
 * Get backup configuration
 */
export async function getConfig(): Promise<BackupConfig> {
  const response = await apiClient.get<ApiResponse<BackupConfig>>('/api/backups/config');
  return response.data.data;
}

/**
 * Get backup statistics
 */
export async function getStats(): Promise<BackupStats> {
  const response = await apiClient.get<ApiResponse<BackupStats>>('/api/backups/stats');
  return response.data.data;
}

/**
 * Get available tables for backup
 */
export async function getTables(): Promise<string[]> {
  const response = await apiClient.get<ApiResponse<string[]>>('/api/backups/tables');
  return response.data.data;
}

/**
 * Get all backups
 */
export async function getBackups(): Promise<{ backups: BackupFile[]; stats: BackupStats }> {
  const response = await apiClient.get<ApiResponse<{ backups: BackupFile[]; stats: BackupStats }>>('/api/backups');
  return response.data.data;
}

/**
 * Create new backup with optional table selection
 */
export async function createBackup(data: CreateBackupInput = {}): Promise<{
  success: boolean;
  message: string;
  filename?: string;
  size?: number;
  recordCount?: number;
}> {
  const response = await apiClient.post<ApiResponse<{
    success: boolean;
    message: string;
    filename?: string;
    size?: number;
    recordCount?: number;
  }>>('/api/backups', data);
  return response.data.data;
}

/**
 * Restore database from backup with options
 */
export async function restoreBackup(
  filename: string, 
  data: RestoreBackupInput = { mode: 'merge' }
): Promise<{
  success: boolean;
  message: string;
  restoredTables?: string[];
  restoredCount?: number;
}> {
  const response = await apiClient.post<ApiResponse<{
    success: boolean;
    message: string;
    restoredTables?: string[];
    restoredCount?: number;
  }>>(`/api/backups/${filename}/restore`, data);
  return response.data.data;
}

/**
 * Delete backup
 */
export async function deleteBackup(filename: string): Promise<void> {
  await apiClient.delete(`/api/backups/${filename}`);
}

/**
 * Backup service object
 */
export const backupService = {
  getConfig,
  getStats,
  getTables,
  getBackups,
  createBackup,
  restoreBackup,
  deleteBackup,
};
