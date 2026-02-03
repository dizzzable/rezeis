import type { QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError, type PaginatedResult } from './base.repository.js';
import type {
  Backup,
  CreateBackupDTO,
  UpdateBackupDTO,
  BackupFilters,
  BackupConfig,
  CreateBackupConfigDTO,
  UpdateBackupConfigDTO,
} from '../entities/backup.entity.js';
import { logger } from '../utils/logger.js';

/**
 * Backup repository class
 * Handles all database operations for backups and backup configuration
 */
export class BackupRepository extends BaseRepository<Backup, CreateBackupDTO, UpdateBackupDTO> {
  protected readonly tableName = 'backups';

  /**
   * Map database row to Backup entity
   * @param row - Database row
   * @returns Backup entity
   */
  protected mapRowToEntity(row: QueryResultRow): Backup {
    return {
      id: row.id,
      filename: row.filename,
      size: row.size,
      status: row.status,
      type: row.type,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      errorMessage: row.error_message,
    };
  }

  /**
   * Find backups by status
   * @param status - Backup status
   * @returns Array of backups
   */
  async findByStatus(status: Backup['status']): Promise<Backup[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM backups WHERE status = $1 ORDER BY created_at DESC',
        [status]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, status }, 'Failed to find backups by status');
      throw new RepositoryError('Failed to find backups by status', error);
    }
  }

  /**
   * Find backups by type
   * @param type - Backup type
   * @returns Array of backups
   */
  async findByType(type: Backup['type']): Promise<Backup[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM backups WHERE type = $1 ORDER BY created_at DESC',
        [type]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, type }, 'Failed to find backups by type');
      throw new RepositoryError('Failed to find backups by type', error);
    }
  }

  /**
   * Get latest completed backups
   * @param limit - Number of backups to return
   * @returns Array of latest backups
   */
  async getLatestBackups(limit: number): Promise<Backup[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM backups ORDER BY created_at DESC LIMIT $1',
        [limit]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, limit }, 'Failed to get latest backups');
      throw new RepositoryError('Failed to get latest backups', error);
    }
  }

  /**
   * Get backups with pagination and filters
   * @param page - Page number
   * @param limit - Items per page
   * @param filters - Optional filters
   * @returns Paginated backups
   */
  async getBackupsWithPagination(
    page: number,
    limit: number,
    filters?: BackupFilters
  ): Promise<PaginatedResult<Backup>> {
    try {
      const offset = (page - 1) * limit;
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (filters?.status) {
        conditions.push(`status = $${paramIndex}`);
        params.push(filters.status);
        paramIndex++;
      }

      if (filters?.type) {
        conditions.push(`type = $${paramIndex}`);
        params.push(filters.type);
        paramIndex++;
      }

      if (filters?.startDate) {
        conditions.push(`created_at >= $${paramIndex}`);
        params.push(filters.startDate);
        paramIndex++;
      }

      if (filters?.endDate) {
        conditions.push(`created_at <= $${paramIndex}`);
        params.push(filters.endDate);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM backups ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const dataResult = await this.db.query<QueryResultRow>(
        `SELECT * FROM backups ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
      );

      return {
        data: dataResult.rows.map((row) => this.mapRowToEntity(row)),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    } catch (error) {
      logger.error({ error, page, limit, filters }, 'Failed to get backups with pagination');
      throw new RepositoryError('Failed to get backups with pagination', error);
    }
  }

  /**
   * Update backup status
   * @param id - Backup ID
   * @param status - New status
   * @param errorMessage - Optional error message
   * @returns Updated backup
   */
  async updateStatus(
    id: string,
    status: Backup['status'],
    errorMessage?: string
  ): Promise<Backup> {
    try {
      const completedAt = status === 'completed' || status === 'failed' ? 'NOW()' : 'NULL';
      const result = await this.db.query<QueryResultRow>(
        `UPDATE backups 
         SET status = $1, 
             completed_at = ${completedAt},
             error_message = $2
         WHERE id = $3 
         RETURNING *`,
        [status, errorMessage || null, id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Backup with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id, status }, 'Failed to update backup status');
      throw new RepositoryError('Failed to update backup status', error);
    }
  }

  /**
   * Get old backups to clean up based on retention count
   * @param retentionCount - Number of backups to keep
   * @returns Array of old backups to delete
   */
  async getOldBackups(retentionCount: number): Promise<Backup[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM backups 
         WHERE id NOT IN (
           SELECT id FROM backups 
           WHERE status = 'completed'
           ORDER BY created_at DESC 
           LIMIT $1
         )
         AND status = 'completed'
         ORDER BY created_at DESC`,
        [retentionCount]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, retentionCount }, 'Failed to get old backups');
      throw new RepositoryError('Failed to get old backups', error);
    }
  }

  /**
   * Count backups by status
   * @param status - Backup status
   * @returns Count of backups
   */
  async countByStatus(status: Backup['status']): Promise<number> {
    try {
      const result = await this.db.query<{ count: string }>(
        'SELECT COUNT(*) FROM backups WHERE status = $1',
        [status]
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ error, status }, 'Failed to count backups by status');
      throw new RepositoryError('Failed to count backups by status', error);
    }
  }

  // Backup Configuration Methods

  /**
   * Get backup configuration
   * @returns Backup config or null if not found
   */
  async getConfig(): Promise<BackupConfig | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM backup_config LIMIT 1'
      );
      return result.rows[0] ? this.mapConfigRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error }, 'Failed to get backup config');
      throw new RepositoryError('Failed to get backup config', error);
    }
  }

  /**
   * Create backup configuration
   * @param data - Backup config creation data
   * @returns Created backup config
   */
  async createConfig(data: CreateBackupConfigDTO): Promise<BackupConfig> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `INSERT INTO backup_config (is_enabled, schedule, backup_time, retention_count)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [data.isEnabled, data.schedule, data.backupTime, data.retentionCount]
      );
      return this.mapConfigRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, data }, 'Failed to create backup config');
      throw new RepositoryError('Failed to create backup config', error);
    }
  }

  /**
   * Update backup configuration
   * @param id - Config ID
   * @param data - Backup config update data
   * @returns Updated backup config
   */
  async updateConfig(id: string, data: UpdateBackupConfigDTO): Promise<BackupConfig> {
    try {
      const updates: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (data.isEnabled !== undefined) {
        updates.push(`is_enabled = $${paramIndex}`);
        params.push(data.isEnabled);
        paramIndex++;
      }

      if (data.schedule) {
        updates.push(`schedule = $${paramIndex}`);
        params.push(data.schedule);
        paramIndex++;
      }

      if (data.backupTime) {
        updates.push(`backup_time = $${paramIndex}`);
        params.push(data.backupTime);
        paramIndex++;
      }

      if (data.retentionCount !== undefined) {
        updates.push(`retention_count = $${paramIndex}`);
        params.push(data.retentionCount);
        paramIndex++;
      }

      if (updates.length === 0) {
        const existing = await this.getConfig();
        if (!existing) {
          throw new RepositoryError('Backup config not found');
        }
        return existing;
      }

      params.push(id);

      const result = await this.db.query<QueryResultRow>(
        `UPDATE backup_config 
         SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${paramIndex}
         RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Backup config with id ${id} not found`);
      }

      return this.mapConfigRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id, data }, 'Failed to update backup config');
      throw new RepositoryError('Failed to update backup config', error);
    }
  }

  /**
   * Map database row to BackupConfig entity
   * @param row - Database row
   * @returns BackupConfig entity
   */
  private mapConfigRowToEntity(row: QueryResultRow): BackupConfig {
    return {
      id: row.id,
      isEnabled: row.is_enabled,
      schedule: row.schedule,
      backupTime: row.backup_time,
      retentionCount: row.retention_count,
      updatedAt: row.updated_at,
    };
  }
}
