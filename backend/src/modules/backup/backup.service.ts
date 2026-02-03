import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Pool } from 'pg';
import { BackupRepository } from '../../repositories/backup.repository.js';
import type { PaginatedResult } from '../../repositories/base.repository.js';
import { logger } from '../../utils/logger.js';
import type {
  Backup,
  BackupConfig,
  BackupFilters,
  BackupType,
} from '../../entities/backup.entity.js';
import type { CreateBackupInput, UpdateBackupConfigInput } from './backup.schemas.js';
import { getEnv } from '../../config/env.js';

const execAsync = promisify(exec);

/**
 * Backup directory path
 */
const BACKUP_DIR = '/backups';

/**
 * Backup not found error
 */
export class BackupNotFoundError extends Error {
  constructor(backupId: string) {
    super(`Backup with id ${backupId} not found`);
    this.name = 'BackupNotFoundError';
  }
}

/**
 * Backup in progress error
 */
export class BackupInProgressError extends Error {
  constructor() {
    super('Another backup is already in progress');
    this.name = 'BackupInProgressError';
  }
}

/**
 * Permission denied error
 */
export class PermissionDeniedError extends Error {
  constructor() {
    super('Only super admin can manage backups');
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Restore not allowed error
 */
export class RestoreNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreNotAllowedError';
  }
}

/**
 * Backup service configuration
 */
interface BackupServiceConfig {
  backupRepository: BackupRepository;
  dbUrl: string;
}

/**
 * Create backup service factory
 * @param db - PostgreSQL pool instance
 * @returns Backup service instance
 */
export function createBackupService(db: Pool): BackupService {
  const backupRepository = new BackupRepository(db);
  const env = getEnv();
  return new BackupService({ backupRepository, dbUrl: env.DATABASE_URL || '' });
}

/**
 * Backup service class
 * Handles all backup-related business logic
 */
class BackupService {
  private readonly backupRepository: BackupRepository;
  private readonly dbUrl: string;

  constructor(config: BackupServiceConfig) {
    this.backupRepository = config.backupRepository;
    this.dbUrl = config.dbUrl;
    this.ensureBackupDirectory();
  }

  /**
   * Ensure backup directory exists
   */
  private ensureBackupDirectory(): void {
    if (!existsSync(BACKUP_DIR)) {
      mkdirSync(BACKUP_DIR, { recursive: true });
      logger.info({ backupDir: BACKUP_DIR }, 'Created backup directory');
    }
  }

  /**
   * Check if user is super admin
   * @param userRole - User role from JWT
   * @returns True if super admin
   */
  private isSuperAdmin(userRole: string): boolean {
    return userRole === 'super_admin';
  }

  /**
   * Verify super admin permission
   * @param userRole - User role from JWT
   * @throws PermissionDeniedError if not super admin
   */
  private verifySuperAdmin(userRole: string): void {
    if (!this.isSuperAdmin(userRole)) {
      throw new PermissionDeniedError();
    }
  }

  /**
   * Map Backup entity to BackupResponse
   * @param backup - Backup entity
   * @returns Backup response object
   */
  private mapBackupToResponse(backup: Backup) {
    return {
      id: backup.id,
      filename: backup.filename,
      size: backup.size,
      status: backup.status,
      type: backup.type,
      createdAt: backup.createdAt.toISOString(),
      completedAt: backup.completedAt?.toISOString(),
      errorMessage: backup.errorMessage,
    };
  }

  /**
   * Map BackupConfig entity to BackupConfigResponse
   * @param config - Backup config entity
   * @returns Backup config response object
   */
  private mapConfigToResponse(config: BackupConfig) {
    return {
      id: config.id,
      isEnabled: config.isEnabled,
      schedule: config.schedule,
      backupTime: config.backupTime,
      retentionCount: config.retentionCount,
      updatedAt: config.updatedAt.toISOString(),
    };
  }

  /**
   * Get backup configuration
   * @returns Backup config or creates default
   */
  async getConfig(): Promise<ReturnType<typeof this.mapConfigToResponse>> {
    let config = await this.backupRepository.getConfig();

    // Create default config if none exists
    if (!config) {
      const defaultConfig: Omit<BackupConfig, 'id' | 'updatedAt'> = {
        isEnabled: false,
        schedule: 'daily',
        backupTime: '02:00',
        retentionCount: 7,
      };
      config = await this.backupRepository.createConfig(defaultConfig);
      logger.info('Created default backup configuration');
    }

    return this.mapConfigToResponse(config);
  }

  /**
   * Update backup configuration
   * @param data - Update config data
   * @param userRole - Current user role for authorization
   * @returns Updated backup config
   */
  async updateConfig(
    data: UpdateBackupConfigInput,
    userRole: string
  ): Promise<ReturnType<typeof this.mapConfigToResponse>> {
    this.verifySuperAdmin(userRole);

    const existingConfig = await this.backupRepository.getConfig();
    if (!existingConfig) {
      // Create new config with defaults merged with updates
      const newConfig: Omit<BackupConfig, 'id' | 'updatedAt'> = {
        isEnabled: data.isEnabled ?? false,
        schedule: data.schedule ?? 'daily',
        backupTime: data.backupTime ?? '02:00',
        retentionCount: data.retentionCount ?? 7,
      };
      const config = await this.backupRepository.createConfig(newConfig);
      logger.info('Created backup configuration');
      return this.mapConfigToResponse(config);
    }

    const config = await this.backupRepository.updateConfig(existingConfig.id, data);
    logger.info({ configId: config.id }, 'Updated backup configuration');
    return this.mapConfigToResponse(config);
  }

  /**
   * Check if a backup is currently in progress
   * @returns True if backup is in progress
   */
  private async isBackupInProgress(): Promise<boolean> {
    const inProgressCount = await this.backupRepository.countByStatus('in_progress');
    return inProgressCount > 0;
  }

  /**
   * Generate backup filename
   * @returns Filename for the backup
   */
  private generateBackupFilename(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `backup_${timestamp}.sql.gz`;
  }

  /**
   * Get file size in bytes
   * @param filepath - Path to file
   * @returns File size in bytes
   */
  private getFileSize(filepath: string): number {
    try {
      const stats = statSync(filepath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  /**
   * Create a new backup
   * @param data - Create backup data
   * @param userRole - Current user role for authorization
   * @returns Created backup
   */
  async createBackup(
    data: CreateBackupInput,
    userRole: string
  ): Promise<ReturnType<typeof this.mapBackupToResponse>> {
    this.verifySuperAdmin(userRole);

    // Check if another backup is already in progress
    if (await this.isBackupInProgress()) {
      throw new BackupInProgressError();
    }

    const filename = this.generateBackupFilename();
    const filepath = join(BACKUP_DIR, filename);

    // Create backup record
    const backup = await this.backupRepository.create({
      filename,
      size: 0,
      status: 'pending',
      type: data.type,
    });

    // Start backup process asynchronously
    this.executeBackup(backup.id, filepath, filename);

    return this.mapBackupToResponse(backup);
  }

  /**
   * Execute the actual backup using pg_dump
   * @param backupId - Backup ID
   * @param filepath - Path to save backup
   * @param filename - Backup filename
   */
  private async executeBackup(
    backupId: string,
    filepath: string,
    filename: string
  ): Promise<void> {
    try {
      // Update status to in_progress
      await this.backupRepository.updateStatus(backupId, 'in_progress');
      logger.info({ backupId, filename }, 'Starting database backup');

      // Extract connection details from DATABASE_URL
      const dbUrl = new URL(this.dbUrl);
      const host = dbUrl.hostname;
      const port = dbUrl.port || '5432';
      const database = dbUrl.pathname.slice(1);
      const username = dbUrl.username;
      const password = dbUrl.password;

      // Set PGPASSWORD environment variable
      const env = { ...process.env, PGPASSWORD: password };

      // Execute pg_dump with compression
      const command = `pg_dump -h ${host} -p ${port} -U ${username} -d ${database} --clean --if-exists --no-owner --no-privileges | gzip > "${filepath}"`;

      await execAsync(command, { env, timeout: 300000 }); // 5 minute timeout

      // Get file size
      const size = this.getFileSize(filepath);

      // Update backup as completed
      await this.backupRepository.updateStatus(backupId, 'completed');
      await this.backupRepository.update(backupId, { size });

      logger.info({ backupId, filename, size }, 'Database backup completed successfully');

      // Clean up old backups based on retention policy
      await this.cleanupOldBackups();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error, backupId }, 'Database backup failed');

      // Update backup as failed
      await this.backupRepository.updateStatus(backupId, 'failed', errorMessage);

      // Clean up partial file if it exists
      try {
        if (existsSync(filepath)) {
          unlinkSync(filepath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Clean up old backups based on retention policy
   */
  private async cleanupOldBackups(): Promise<void> {
    try {
      const config = await this.backupRepository.getConfig();
      const retentionCount = config?.retentionCount ?? 7;

      const oldBackups = await this.backupRepository.getOldBackups(retentionCount);

      for (const backup of oldBackups) {
        const filepath = join(BACKUP_DIR, backup.filename);
        try {
          if (existsSync(filepath)) {
            unlinkSync(filepath);
          }
          await this.backupRepository.delete(backup.id);
          logger.info({ backupId: backup.id, filename: backup.filename }, 'Deleted old backup');
        } catch (cleanupError) {
          logger.error(
            { error: cleanupError, backupId: backup.id },
            'Failed to delete old backup file'
          );
        }
      }
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup old backups');
    }
  }

  /**
   * Get backups with pagination and filters
   * @param params - Query parameters
   * @param userRole - Current user role for authorization
   * @returns Paginated backups
   */
  async getBackups(
    params: { page: number; limit: number; status?: Backup['status']; type?: Backup['type'] },
    userRole: string
  ): Promise<PaginatedResult<ReturnType<typeof this.mapBackupToResponse>>> {
    this.verifySuperAdmin(userRole);

    const filters: BackupFilters = {};
    if (params.status) {
      filters.status = params.status;
    }
    if (params.type) {
      filters.type = params.type;
    }

    const result = await this.backupRepository.getBackupsWithPagination(
      params.page,
      params.limit,
      Object.keys(filters).length > 0 ? filters : undefined
    );

    return {
      data: result.data.map((backup) => this.mapBackupToResponse(backup)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  /**
   * Get backup by ID
   * @param id - Backup ID
   * @param userRole - Current user role for authorization
   * @returns Backup or null
   */
  async getBackupById(
    id: string,
    userRole: string
  ): Promise<ReturnType<typeof this.mapBackupToResponse> | null> {
    this.verifySuperAdmin(userRole);

    const backup = await this.backupRepository.findById(id);
    return backup ? this.mapBackupToResponse(backup) : null;
  }

  /**
   * Restore from backup
   * @param id - Backup ID
   * @param userRole - Current user role for authorization
   */
  async restoreBackup(id: string, userRole: string): Promise<void> {
    this.verifySuperAdmin(userRole);

    const backup = await this.backupRepository.findById(id);
    if (!backup) {
      throw new BackupNotFoundError(id);
    }

    if (backup.status !== 'completed') {
      throw new RestoreNotAllowedError('Can only restore from completed backups');
    }

    const filepath = join(BACKUP_DIR, backup.filename);
    if (!existsSync(filepath)) {
      throw new RestoreNotAllowedError('Backup file not found');
    }

    try {
      logger.info({ backupId: id, filename: backup.filename }, 'Starting database restore');

      // Extract connection details from DATABASE_URL
      const dbUrl = new URL(this.dbUrl);
      const host = dbUrl.hostname;
      const port = dbUrl.port || '5432';
      const database = dbUrl.pathname.slice(1);
      const username = dbUrl.username;
      const password = dbUrl.password;

      // Set PGPASSWORD environment variable
      const env = { ...process.env, PGPASSWORD: password };

      // Execute restore using gunzip and psql
      const command = `gunzip -c "${filepath}" | psql -h ${host} -p ${port} -U ${username} -d ${database}`;

      await execAsync(command, { env, timeout: 600000 }); // 10 minute timeout

      logger.info({ backupId: id }, 'Database restore completed successfully');
    } catch (error) {
      logger.error({ error, backupId: id }, 'Database restore failed');
      throw new RestoreNotAllowedError(
        error instanceof Error ? error.message : 'Restore failed'
      );
    }
  }

  /**
   * Delete backup
   * @param id - Backup ID
   * @param userRole - Current user role for authorization
   */
  async deleteBackup(id: string, userRole: string): Promise<void> {
    this.verifySuperAdmin(userRole);

    const backup = await this.backupRepository.findById(id);
    if (!backup) {
      throw new BackupNotFoundError(id);
    }

    // Delete backup file if it exists
    const filepath = join(BACKUP_DIR, backup.filename);
    try {
      if (existsSync(filepath)) {
        unlinkSync(filepath);
      }
    } catch (error) {
      logger.error({ error, backupId: id }, 'Failed to delete backup file');
    }

    // Delete backup record
    await this.backupRepository.delete(id);
    logger.info({ backupId: id }, 'Backup deleted successfully');
  }

  /**
   * Run scheduled backup (for cron jobs)
   */
  async runScheduledBackup(): Promise<void> {
    const config = await this.backupRepository.getConfig();

    // Check if backups are enabled
    if (!config || !config.isEnabled) {
      logger.info('Scheduled backup skipped: backups not enabled');
      return;
    }

    // Check if another backup is already in progress
    if (await this.isBackupInProgress()) {
      logger.info('Scheduled backup skipped: another backup is in progress');
      return;
    }

    const filename = this.generateBackupFilename();
    const filepath = join(BACKUP_DIR, filename);

    // Create backup record
    const backup = await this.backupRepository.create({
      filename,
      size: 0,
      status: 'pending',
      type: 'scheduled' as BackupType,
    });

    // Start backup process
    await this.executeBackup(backup.id, filepath, filename);
  }
}
