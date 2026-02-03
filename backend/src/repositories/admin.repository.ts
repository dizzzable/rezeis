import type { QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError, type PaginatedResult } from './base.repository.js';
import type { Admin, CreateAdminDTO, UpdateAdminDTO, AdminFilters } from '../entities/admin.entity.js';
import { logger } from '../utils/logger.js';

/**
 * Admin repository class
 * Handles all database operations for admins
 */
export class AdminRepository extends BaseRepository<Admin, CreateAdminDTO, UpdateAdminDTO> {
  protected readonly tableName = 'admins';

  /**
   * Map database row to Admin entity
   * @param row - Database row
   * @returns Admin entity
   */
  protected mapRowToEntity(row: QueryResultRow): Admin {
    return {
      id: row.id,
      telegramId: row.telegram_id,
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.role,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find admin by Telegram ID
   * @param telegramId - Telegram user ID
   * @returns Admin or null if not found
   */
  async findByTelegramId(telegramId: string): Promise<Admin | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM admins WHERE telegram_id = $1',
        [telegramId]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, telegramId }, 'Failed to find admin by Telegram ID');
      throw new RepositoryError('Failed to find admin by Telegram ID', error);
    }
  }

  /**
   * Find all active admins
   * @returns Array of active admins
   */
  async findActiveAdmins(): Promise<Admin[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM admins WHERE is_active = true ORDER BY created_at DESC'
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error }, 'Failed to find active admins');
      throw new RepositoryError('Failed to find active admins', error);
    }
  }

  /**
   * Find super admin
   * @returns Super admin or null if not found
   */
  async findSuperAdmin(): Promise<Admin | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        "SELECT * FROM admins WHERE role = 'super_admin' LIMIT 1"
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error }, 'Failed to find super admin');
      throw new RepositoryError('Failed to find super admin', error);
    }
  }

  /**
   * Search admins by query (username, first name, last name, telegram_id)
   * @param query - Search query
   * @returns Array of matching admins
   */
  async searchAdmins(query: string): Promise<Admin[]> {
    try {
      const searchTerm = `%${query}%`;
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM admins 
         WHERE username ILIKE $1 
         OR first_name ILIKE $1 
         OR last_name ILIKE $1 
         OR telegram_id ILIKE $1
         ORDER BY created_at DESC`,
        [searchTerm]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, query }, 'Failed to search admins');
      throw new RepositoryError('Failed to search admins', error);
    }
  }

  /**
   * Get admins with pagination and filters
   * @param page - Page number
   * @param limit - Items per page
   * @param filters - Optional filters
   * @returns Paginated admins
   */
  async getAdminsWithPagination(
    page: number,
    limit: number,
    filters?: AdminFilters
  ): Promise<PaginatedResult<Admin>> {
    try {
      const offset = (page - 1) * limit;
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (filters?.role) {
        conditions.push(`role = $${paramIndex}`);
        params.push(filters.role);
        paramIndex++;
      }

      if (filters?.isActive !== undefined) {
        conditions.push(`is_active = $${paramIndex}`);
        params.push(filters.isActive);
        paramIndex++;
      }

      if (filters?.search) {
        conditions.push(`(username ILIKE $${paramIndex} OR first_name ILIKE $${paramIndex} OR last_name ILIKE $${paramIndex} OR telegram_id ILIKE $${paramIndex})`);
        params.push(`%${filters.search}%`);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM admins ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const dataResult = await this.db.query<QueryResultRow>(
        `SELECT * FROM admins ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
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
      logger.error({ error, page, limit, filters }, 'Failed to get admins with pagination');
      throw new RepositoryError('Failed to get admins with pagination', error);
    }
  }

  /**
   * Update admin role
   * @param id - Admin ID
   * @param role - New role
   * @returns Updated admin
   */
  async updateRole(id: string, role: 'super_admin' | 'admin'): Promise<Admin> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'UPDATE admins SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [role, id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Admin with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id, role }, 'Failed to update admin role');
      throw new RepositoryError('Failed to update admin role', error);
    }
  }

  /**
   * Count admins by role
   * @param role - Admin role
   * @returns Count of admins with the role
   */
  async countByRole(role: string): Promise<number> {
    try {
      const result = await this.db.query<{ count: string }>(
        'SELECT COUNT(*) FROM admins WHERE role = $1',
        [role]
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ error, role }, 'Failed to count admins by role');
      throw new RepositoryError('Failed to count admins by role', error);
    }
  }
}
