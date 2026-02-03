import type { QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError } from './base.repository.js';
import type {
  PromocodeActivation,
  CreatePromocodeActivationDTO,
} from '../entities/promocode.entity.js';
import { logger } from '../utils/logger.js';

/**
 * PromocodeActivation repository class
 * Handles all database operations for promocode activations
 */
export class PromocodeActivationRepository extends BaseRepository<
  PromocodeActivation,
  CreatePromocodeActivationDTO,
  Record<string, unknown>
> {
  protected readonly tableName = 'promocode_activations';

  /**
   * Map database row to PromocodeActivation entity
   * @param row - Database row
   * @returns PromocodeActivation entity
   */
  protected mapRowToEntity(row: QueryResultRow): PromocodeActivation {
    return {
      id: row.id,
      promocodeId: row.promocode_id,
      userId: row.user_id,
      subscriptionId: row.subscription_id,
      purchaseAmount: row.purchase_amount ? parseFloat(row.purchase_amount as string) : undefined,
      discountApplied: row.discount_applied ? parseFloat(row.discount_applied as string) : undefined,
      rewardApplied: row.reward_applied as PromocodeActivation['rewardApplied'],
      activatedAt: row.activated_at,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
    };
  }

  /**
   * Create a new promocode activation
   * @param data - Activation data
   * @returns Created activation
   */
  async create(data: CreatePromocodeActivationDTO): Promise<PromocodeActivation> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `INSERT INTO promocode_activations 
          (promocode_id, user_id, subscription_id, purchase_amount, discount_applied, reward_applied, ip_address, user_agent)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *`,
        [
          data.promocodeId,
          data.userId,
          data.subscriptionId,
          data.purchaseAmount,
          data.discountApplied,
          data.rewardApplied ? JSON.stringify(data.rewardApplied) : null,
          data.ipAddress,
          data.userAgent,
        ]
      );
      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, data }, 'Failed to create promocode activation');
      throw new RepositoryError('Failed to create promocode activation', error);
    }
  }

  /**
   * Find activation by user and promocode
   * @param userId - User ID
   * @param promocodeId - Promocode ID
   * @returns Activation or null if not found
   */
  async findByUserAndPromocode(
    userId: string,
    promocodeId: string
  ): Promise<PromocodeActivation | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM promocode_activations 
          WHERE user_id = $1 AND promocode_id = $2 
          ORDER BY activated_at DESC 
          LIMIT 1`,
        [userId, promocodeId]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, userId, promocodeId }, 'Failed to find activation by user and promocode');
      throw new RepositoryError('Failed to find activation by user and promocode', error);
    }
  }

  /**
   * Find activations by subscription
   * @param subscriptionId - Subscription ID
   * @returns Array of activations
   */
  async findBySubscription(subscriptionId: string): Promise<PromocodeActivation[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM promocode_activations 
          WHERE subscription_id = $1 
          ORDER BY activated_at DESC`,
        [subscriptionId]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, subscriptionId }, 'Failed to find activations by subscription');
      throw new RepositoryError('Failed to find activations by subscription', error);
    }
  }

  /**
   * Get user activation history with pagination
   * @param userId - User ID
   * @param page - Page number
   * @param limit - Items per page
   * @returns Paginated activations
   */
  async getUserHistory(
    userId: string,
    page: number,
    limit: number
  ): Promise<{ data: PromocodeActivation[]; total: number; totalPages: number }> {
    try {
      const offset = (page - 1) * limit;

      const countResult = await this.db.query<{ count: string }>(
        'SELECT COUNT(*) FROM promocode_activations WHERE user_id = $1',
        [userId]
      );
      const total = parseInt(countResult.rows[0].count, 10);
      const totalPages = Math.ceil(total / limit);

      const dataResult = await this.db.query<QueryResultRow>(
        `SELECT * FROM promocode_activations 
          WHERE user_id = $1 
          ORDER BY activated_at DESC 
          LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      return {
        data: dataResult.rows.map((row) => this.mapRowToEntity(row)),
        total,
        totalPages,
      };
    } catch (error) {
      logger.error({ error, userId, page, limit }, 'Failed to get user history');
      throw new RepositoryError('Failed to get user history', error);
    }
  }

  /**
   * Find activations by promocode ID
   * @param promocodeId - Promocode ID
   * @returns Array of activations
   */
  async findByPromocodeId(promocodeId: string): Promise<PromocodeActivation[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM promocode_activations 
          WHERE promocode_id = $1 
          ORDER BY activated_at DESC`,
        [promocodeId]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, promocodeId }, 'Failed to find activations by promocode');
      throw new RepositoryError('Failed to find activations by promocode', error);
    }
  }
}
