import type { QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError } from './base.repository.js';
import type {
  UserPersonalDiscount,
  CreateUserPersonalDiscountDTO,
  UpdateUserPersonalDiscountDTO,
} from '../entities/subscription.entity.js';
import { logger } from '../utils/logger.js';

/**
 * UserPersonalDiscount repository class
 * Handles all database operations for user personal discounts
 */
export class UserPersonalDiscountRepository extends BaseRepository<
  UserPersonalDiscount,
  CreateUserPersonalDiscountDTO,
  UpdateUserPersonalDiscountDTO
> {
  protected readonly tableName = 'user_personal_discounts';

  /**
   * Map database row to UserPersonalDiscount entity
   * @param row - Database row
   * @returns UserPersonalDiscount entity
   */
  protected mapRowToEntity(row: QueryResultRow): UserPersonalDiscount {
    return {
      id: row.id,
      userId: row.user_id,
      discountPercent: row.discount_percent,
      discountAmount: row.discount_amount ? parseFloat(row.discount_amount as string) : undefined,
      sourceType: row.source_type,
      sourceId: row.source_id,
      isActive: row.is_active,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      usedCount: row.used_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find active personal discount by user ID
   * @param userId - User ID
   * @returns Active personal discount or null if not found/expired
   */
  async findActiveByUserId(userId: string): Promise<UserPersonalDiscount | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM user_personal_discounts 
          WHERE user_id = $1 
          AND is_active = true 
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (max_uses = -1 OR used_count < max_uses)
          ORDER BY discount_percent DESC
          LIMIT 1`,
        [userId]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to find active personal discount by user ID');
      throw new RepositoryError('Failed to find active personal discount by user ID', error);
    }
  }

  /**
   * Find all personal discounts for a user
   * @param userId - User ID
   * @returns Array of personal discounts
   */
  async findByUserId(userId: string): Promise<UserPersonalDiscount[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM user_personal_discounts 
          WHERE user_id = $1 
          ORDER BY created_at DESC`,
        [userId]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, userId }, 'Failed to find personal discounts by user ID');
      throw new RepositoryError('Failed to find personal discounts by user ID', error);
    }
  }

  /**
   * Get source discounts for a user (by source type and ID)
   * @param userId - User ID
   * @param sourceType - Source type
   * @param sourceId - Source ID
   * @returns Array of personal discounts
   */
  async getSourceDiscounts(
    userId: string,
    sourceType: string,
    sourceId: string
  ): Promise<UserPersonalDiscount[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM user_personal_discounts 
          WHERE user_id = $1 AND source_type = $2 AND source_id = $3`,
        [userId, sourceType, sourceId]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, userId, sourceType, sourceId }, 'Failed to get source discounts');
      throw new RepositoryError('Failed to get source discounts', error);
    }
  }

  /**
   * Create a new personal discount
   * @param data - Discount data
   * @returns Created discount
   */
  async create(data: CreateUserPersonalDiscountDTO): Promise<UserPersonalDiscount> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `INSERT INTO user_personal_discounts 
          (user_id, discount_percent, discount_amount, source_type, source_id, is_active, expires_at, max_uses)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *`,
        [
          data.userId,
          data.discountPercent,
          data.discountAmount,
          data.sourceType,
          data.sourceId,
          data.isActive ?? true,
          data.expiresAt,
          data.maxUses ?? -1,
        ]
      );
      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, data }, 'Failed to create personal discount');
      throw new RepositoryError('Failed to create personal discount', error);
    }
  }

  /**
   * Increment usage count for a discount
   * @param discountId - Discount ID
   * @returns Updated discount
   */
  async incrementUsage(discountId: string): Promise<UserPersonalDiscount> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE user_personal_discounts 
          SET used_count = used_count + 1, updated_at = NOW() 
          WHERE id = $1 
          RETURNING *`,
        [discountId]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Personal discount with id ${discountId} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, discountId }, 'Failed to increment discount usage');
      throw new RepositoryError('Failed to increment discount usage', error);
    }
  }

  /**
   * Deactivate a discount
   * @param discountId - Discount ID
   * @returns Updated discount
   */
  async deactivate(discountId: string): Promise<UserPersonalDiscount> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE user_personal_discounts 
          SET is_active = false, updated_at = NOW() 
          WHERE id = $1 
          RETURNING *`,
        [discountId]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Personal discount with id ${discountId} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, discountId }, 'Failed to deactivate personal discount');
      throw new RepositoryError('Failed to deactivate personal discount', error);
    }
  }

  /**
   * Get the active personal discount percentage for a user
   * @param userId - User ID
   * @returns Discount percentage (0 if none)
   */
  async getActiveDiscountPercent(userId: string): Promise<number> {
    try {
      const result = await this.db.query<{ discount_percent: string }>(
        `SELECT discount_percent FROM user_personal_discounts 
          WHERE user_id = $1 
          AND is_active = true 
          AND (expires_at IS NULL OR expires_at > NOW())
          AND (max_uses = -1 OR used_count < max_uses)
          ORDER BY discount_percent DESC
          LIMIT 1`,
        [userId]
      );
      return result.rows[0] ? parseInt(result.rows[0].discount_percent, 10) : 0;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get active discount percent');
      throw new RepositoryError('Failed to get active discount percent', error);
    }
  }
}
