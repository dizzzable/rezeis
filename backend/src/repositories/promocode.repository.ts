import type { QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError } from './base.repository.js';
import type {
  Promocode,
  CreatePromocodeDTO,
  UpdatePromocodeDTO,
  PromocodeRewardType,
  PromocodeAvailability,
} from '../entities/promocode.entity.js';
import { logger } from '../utils/logger.js';

/**
 * Promocode repository class - enhanced version for VPN MiniApp
 * Handles all database operations for promocodes with support for all reward types
 */
export class PromocodeRepository extends BaseRepository<
  Promocode,
  CreatePromocodeDTO,
  UpdatePromocodeDTO
> {
  protected readonly tableName = 'promocodes';

  /**
   * Map database row to Promocode entity
   * @param row - Database row
   * @returns Promocode entity
   */
  protected mapRowToEntity(row: QueryResultRow): Promocode {
    return {
      id: row.id,
      code: row.code,
      description: row.description,
      rewardType: row.reward_type as PromocodeRewardType,
      rewardValue: row.reward_value,
      rewardPlanId: row.reward_plan_id,
      planSnapshot: row.plan_snapshot,
      availability: row.availability as PromocodeAvailability,
      allowedUserIds: row.allowed_user_ids || [],
      maxUses: row.max_uses,
      usedCount: row.used_count,
      maxUsesPerUser: row.max_uses_per_user,
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
      isActive: row.is_active,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find promocode by code
   * @param code - Promocode code
   * @returns Promocode or null if not found
   */
  async findByCode(code: string): Promise<Promocode | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM promocodes WHERE code = $1',
        [code]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, code }, 'Failed to find promocode by code');
      throw new RepositoryError('Failed to find promocode by code', error);
    }
  }

  /**
   * Find valid promocode for a user (active, not expired, within usage limits)
   * @param code - Promocode code
   * @param userId - User ID to check per-user limits
   * @returns Promocode or null if not found/valid
   */
  async findValid(code: string, userId?: string): Promise<Promocode | null> {
    try {
      let query = `SELECT * FROM promocodes 
        WHERE code = $1 
        AND is_active = true 
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (max_uses = -1 OR used_count < max_uses)`;

      const params: unknown[] = [code];

      if (userId) {
        query += ` AND (availability = 'all' OR availability = $2)`;
        params.push('all');
      }

      const result = await this.db.query<QueryResultRow>(query, params);
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, code, userId }, 'Failed to find valid promocode');
      throw new RepositoryError('Failed to find valid promocode', error);
    }
  }

  /**
   * Find all active promocodes that haven't expired
   * @returns Array of active promocodes
   */
  async findActive(): Promise<Promocode[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM promocodes 
          WHERE is_active = true 
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY created_at DESC`
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error }, 'Failed to find active promocodes');
      throw new RepositoryError('Failed to find active promocodes', error);
    }
  }

  /**
   * Find promocodes by reward type
   * @param rewardType - Reward type to filter by
   * @returns Array of promocodes with the specified reward type
   */
  async findByRewardType(rewardType: PromocodeRewardType): Promise<Promocode[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM promocodes WHERE reward_type = $1 AND is_active = true ORDER BY created_at DESC',
        [rewardType]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, rewardType }, 'Failed to find promocodes by reward type');
      throw new RepositoryError('Failed to find promocodes by reward type', error);
    }
  }

  /**
   * Increment used count for a promocode
   * @param id - Promocode ID
   * @returns Updated promocode
   */
  async incrementUsedCount(id: string): Promise<Promocode> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE promocodes 
          SET used_count = used_count + 1, updated_at = NOW() 
          WHERE id = $1 
          RETURNING *`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Promocode with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id }, 'Failed to increment promocode used count');
      throw new RepositoryError('Failed to increment promocode used count', error);
    }
  }

  /**
   * Toggle promocode active status
   * @param id - Promocode ID
   * @returns Updated promocode
   */
  async toggleActive(id: string): Promise<Promocode> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE promocodes 
          SET is_active = NOT is_active, updated_at = NOW() 
          WHERE id = $1 
          RETURNING *`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Promocode with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id }, 'Failed to toggle promocode active status');
      throw new RepositoryError('Failed to toggle promocode active status', error);
    }
  }

  /**
   * Deactivate promocode
   * @param id - Promocode ID
   * @returns Updated promocode
   */
  async deactivate(id: string): Promise<Promocode> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE promocodes 
          SET is_active = false, updated_at = NOW() 
          WHERE id = $1 
          RETURNING *`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Promocode with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id }, 'Failed to deactivate promocode');
      throw new RepositoryError('Failed to deactivate promocode', error);
    }
  }

  /**
   * Get activations for a promocode with pagination
   * @param promocodeId - Promocode ID
   * @param page - Page number
   * @param limit - Items per page
   * @returns Paginated activations
   */
  async getActivations(
    promocodeId: string,
    page: number,
    limit: number
  ): Promise<{ data: Array<{ userId: string; activatedAt: Date; rewardApplied: unknown }>; total: number }> {
    try {
      const offset = (page - 1) * limit;

      const countResult = await this.db.query<{ count: string }>(
        'SELECT COUNT(*) FROM promocode_activations WHERE promocode_id = $1',
        [promocodeId]
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const dataResult = await this.db.query<QueryResultRow>(
        `SELECT user_id, activated_at, reward_applied 
          FROM promocode_activations 
          WHERE promocode_id = $1 
          ORDER BY activated_at DESC 
          LIMIT $2 OFFSET $3`,
        [promocodeId, limit, offset]
      );

      return {
        data: dataResult.rows.map((row) => ({
          userId: row.user_id,
          activatedAt: row.activated_at,
          rewardApplied: row.reward_applied,
        })),
        total,
      };
    } catch (error) {
      logger.error({ error, promocodeId, page, limit }, 'Failed to get activations');
      throw new RepositoryError('Failed to get activations', error);
    }
  }

  /**
   * Count activations for a promocode
   * @param promocodeId - Promocode ID
   * @returns Count of activations
   */
  async countActivations(promocodeId: string): Promise<number> {
    try {
      const result = await this.db.query<{ count: string }>(
        'SELECT COUNT(*) FROM promocode_activations WHERE promocode_id = $1',
        [promocodeId]
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ error, promocodeId }, 'Failed to count activations');
      throw new RepositoryError('Failed to count activations', error);
    }
  }

  /**
   * Count user activations for a promocode
   * @param promocodeId - Promocode ID
   * @param userId - User ID
   * @returns Count of activations for this user
   */
  async countUserActivations(promocodeId: string, userId: string): Promise<number> {
    try {
      const result = await this.db.query<{ count: string }>(
        'SELECT COUNT(*) FROM promocode_activations WHERE promocode_id = $1 AND user_id = $2',
        [promocodeId, userId]
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ error, promocodeId, userId }, 'Failed to count user activations');
      throw new RepositoryError('Failed to count user activations', error);
    }
  }
}
