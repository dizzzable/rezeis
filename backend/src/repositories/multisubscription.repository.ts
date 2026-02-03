import type { Pool, QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError, type PaginatedResult, type PaginationOptions } from './base.repository.js';
import type { Multisubscription, CreateMultisubscriptionDto, UpdateMultisubscriptionDto, MultisubscriptionFilters } from '../entities/multisubscription.entity.js';
import { logger } from '../utils/logger.js';

/**
 * Multisubscription repository class
 * Extends BaseRepository for CRUD operations
 */
export class MultisubscriptionRepository extends BaseRepository<
  Multisubscription,
  CreateMultisubscriptionDto,
  UpdateMultisubscriptionDto
> {
  protected readonly tableName = 'user_multisubscriptions';

  constructor(db: Pool) {
    super(db);
  }

  /**
   * Map database row to Multisubscription entity
   */
  protected mapRowToEntity(row: QueryResultRow): Multisubscription {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      description: row.description,
      subscriptionIds: row.subscription_ids || [],
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find multisubscriptions by user ID
   */
  async findByUserId(userId: string): Promise<Multisubscription[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM ${this.tableName} WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, userId }, 'Failed to find multisubscriptions by user ID');
      throw new RepositoryError('Failed to find multisubscriptions by user ID', error);
    }
  }

  /**
   * Find multisubscriptions with filters and pagination
   */
  async findWithFilters(
    filters: MultisubscriptionFilters,
    options: PaginationOptions
  ): Promise<PaginatedResult<Multisubscription>> {
    try {
      const { page, limit, sortBy = 'created_at', sortOrder = 'desc' } = options;
      const offset = (page - 1) * limit;
      const sortColumn = this.camelToSnake(sortBy);

      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (filters.userId) {
        conditions.push(`user_id = $${paramIndex}`);
        params.push(filters.userId);
        paramIndex++;
      }

      if (filters.isActive !== undefined) {
        conditions.push(`is_active = $${paramIndex}`);
        params.push(filters.isActive);
        paramIndex++;
      }

      if (filters.search) {
        conditions.push(`(name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`);
        params.push(`%${filters.search}%`);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM ${this.tableName} ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const dataResult = await this.db.query<QueryResultRow>(
        `SELECT * FROM ${this.tableName} ${whereClause} ORDER BY ${sortColumn} ${sortOrder.toUpperCase()} LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
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
      logger.error({ error, filters, options }, 'Failed to find multisubscriptions with filters');
      throw new RepositoryError('Failed to find multisubscriptions with filters', error);
    }
  }

  /**
   * Count active multisubscriptions
   */
  async countActive(): Promise<number> {
    try {
      const result = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM ${this.tableName} WHERE is_active = true`
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ error }, 'Failed to count active multisubscriptions');
      throw new RepositoryError('Failed to count active multisubscriptions', error);
    }
  }

  /**
   * Count multisubscriptions by user ID
   */
  async countByUserId(userId: string): Promise<number> {
    try {
      const result = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM ${this.tableName} WHERE user_id = $1`,
        [userId]
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ error, userId }, 'Failed to count multisubscriptions by user ID');
      throw new RepositoryError('Failed to count multisubscriptions by user ID', error);
    }
  }
}
