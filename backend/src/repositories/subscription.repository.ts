import type { QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError } from './base.repository.js';
import type { Subscription, CreateSubscriptionDTO, UpdateSubscriptionDTO, SubscriptionStatus } from '../entities/subscription.entity.js';
import { logger } from '../utils/logger.js';

/**
 * Subscription repository class
 * Handles all database operations for subscriptions
 */
export class SubscriptionRepository extends BaseRepository<Subscription, CreateSubscriptionDTO, UpdateSubscriptionDTO> {
  protected readonly tableName = 'subscriptions';

  /**
   * Map database row to Subscription entity
   * @param row - Database row
   * @returns Subscription entity
   */
  protected mapRowToEntity(row: QueryResultRow): Subscription {
    return {
      id: row.id,
      userId: row.user_id,
      planId: row.plan_id,
      status: row.status,
      startDate: row.start_date,
      endDate: row.end_date,
      remnawaveUuid: row.remnawave_uuid,
      subscriptionType: row.subscription_type ?? 'regular',
      deviceType: row.device_type,
      deviceCount: row.device_count ?? 1,
      isTrial: row.is_trial ?? false,
      trialEndsAt: row.trial_ends_at,
      trialParentId: row.trial_parent_id,
      subscriptionIndex: row.subscription_index ?? 0,
      snapshot: row.snapshot,
      trafficLimitGb: row.traffic_limit_gb,
      trafficUsedGb: row.traffic_used_gb ?? 0,
      renewedFromId: row.renewed_from_id,
      renewedToId: row.renewed_to_id,
      purchasedWithPromocodeId: row.purchased_with_promocode_id,
      promoDiscountPercent: row.promo_discount_percent ?? 0,
      promoDiscountAmount: row.promo_discount_amount ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find subscriptions by user ID
   * @param userId - User ID
   * @returns Array of subscriptions
   */
  async findByUserId(userId: string): Promise<Subscription[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, userId }, 'Failed to find subscriptions by user ID');
      throw new RepositoryError('Failed to find subscriptions by user ID', error);
    }
  }

  /**
   * Find active subscription by user ID
   * @param userId - User ID
   * @returns Active subscription or null
   */
  async findActiveByUserId(userId: string): Promise<Subscription | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM subscriptions 
         WHERE user_id = $1 AND status = 'active' AND end_date > NOW()
         ORDER BY end_date DESC LIMIT 1`,
        [userId]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to find active subscription by user ID');
      throw new RepositoryError('Failed to find active subscription by user ID', error);
    }
  }

  /**
   * Find subscriptions expiring soon
   * @param days - Number of days until expiration
   * @returns Array of expiring subscriptions
   */
  async findExpiringSoon(days: number): Promise<Subscription[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM subscriptions 
         WHERE status = 'active' 
         AND end_date BETWEEN NOW() AND NOW() + INTERVAL '${days} days'
         ORDER BY end_date ASC`,
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, days }, 'Failed to find expiring subscriptions');
      throw new RepositoryError('Failed to find expiring subscriptions', error);
    }
  }

  /**
   * Count subscriptions by status
   * @param status - Subscription status
   * @returns Count of subscriptions
   */
  async countByStatus(status: SubscriptionStatus): Promise<number> {
    try {
      const result = await this.db.query<{ count: string }>(
        'SELECT COUNT(*) FROM subscriptions WHERE status = $1',
        [status]
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ error, status }, 'Failed to count subscriptions by status');
      throw new RepositoryError('Failed to count subscriptions by status', error);
    }
  }

  /**
   * Get revenue by period
   * @param startDate - Start date
   * @param endDate - End date
   * @returns Total revenue
   */
  async getRevenueByPeriod(startDate: Date, endDate: Date): Promise<number> {
    try {
      const result = await this.db.query<{ revenue: string }>(
        `SELECT COALESCE(SUM(plans.price), 0) as revenue 
         FROM subscriptions 
         JOIN plans ON subscriptions.plan_id = plans.id 
         WHERE subscriptions.created_at BETWEEN $1 AND $2 
         AND subscriptions.status != 'cancelled'`,
        [startDate, endDate]
      );
      return parseFloat(result.rows[0].revenue);
    } catch (error) {
      logger.error({ error, startDate, endDate }, 'Failed to get revenue by period');
      throw new RepositoryError('Failed to get revenue by period', error);
    }
  }

  /**
   * Update subscription status
   * @param id - Subscription ID
   * @param status - New status
   * @returns Updated subscription
   */
  async updateStatus(id: string, status: SubscriptionStatus): Promise<Subscription> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE subscriptions 
         SET status = $1, updated_at = NOW() 
         WHERE id = $2 
         RETURNING *`,
        [status, id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Subscription with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id, status }, 'Failed to update subscription status');
      throw new RepositoryError('Failed to update subscription status', error);
    }
  }

  /**
   * Find subscriptions by plan ID
   * @param planId - Plan ID
   * @returns Array of subscriptions
   */
  async findByPlanId(planId: string): Promise<Subscription[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM subscriptions WHERE plan_id = $1 ORDER BY created_at DESC',
        [planId]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, planId }, 'Failed to find subscriptions by plan ID');
      throw new RepositoryError('Failed to find subscriptions by plan ID', error);
    }
  }

  /**
   * Cancel subscription
   * @param id - Subscription ID
   * @returns Updated subscription
   */
  async cancelSubscription(id: string): Promise<Subscription> {
    return this.updateStatus(id, 'cancelled');
  }

  /**
   * Expire subscription
   * @param id - Subscription ID
   * @returns Updated subscription
   */
  async expireSubscription(id: string): Promise<Subscription> {
    return this.updateStatus(id, 'expired');
  }
}
