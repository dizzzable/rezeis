// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { getPool } from '../../config/database.js';
import { Cacheable, InvalidateCache } from '../../cache/decorators.js';
import { logger } from '../../utils/logger.js';

/**
 * Client service for user-facing operations
 * Provides methods for managing user subscriptions, payments, referrals, etc.
 * All methods use caching for improved performance.
 */
export class ClientService {

  /**
   * Get user profile
   * @param userId User ID
   * @returns User profile data
   */
  @Cacheable({
    configKey: 'userProfile',
    keyGenerator: (args) => `profile:${args[0]}`,
    tags: ['user'],
  })
  async getUserProfile(userId: string): Promise<Record<string, unknown> | null> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT id, username, telegram_id, first_name, last_name, photo_url,
                role, is_active, last_login_at, created_at
         FROM users
         WHERE id = $1`,
        [userId]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get user profile');
      throw error;
    }
  }

  /**
   * Get user statistics
   * @param userId User ID
   * @returns User statistics
   */
  @Cacheable({
    configKey: 'userStats',
    keyGenerator: (args) => `stats:${args[0]}`,
    tags: ['user', 'stats'],
  })
  async getUserStats(userId: string): Promise<Record<string, unknown>> {
    const pool = getPool();

    try {
      // Get active subscriptions count
      const subscriptionsResult = await pool.query(
        `SELECT COUNT(*) as active_subscriptions,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
                SUM(CASE WHEN expire_at > NOW() AND expire_at < NOW() + INTERVAL '7 days' THEN 1 ELSE 0 END) as expiring_soon
         FROM subscriptions
         WHERE user_id = $1`,
        [userId]
      );

      // Get total traffic used
      const trafficResult = await pool.query(
        `SELECT COALESCE(SUM(traffic_used), 0) as total_traffic_used,
                COALESCE(SUM(traffic_limit), 0) as total_traffic_limit
         FROM subscriptions
         WHERE user_id = $1 AND status = 'active'`,
        [userId]
      );

      // Get referral stats
      const referralResult = await pool.query(
        `SELECT COUNT(*) as referral_count,
                COALESCE(SUM(points), 0) as total_points
         FROM referrals
         WHERE referrer_id = $1`,
        [userId]
      );

      return {
        subscriptions: subscriptionsResult.rows[0],
        traffic: trafficResult.rows[0],
        referrals: referralResult.rows[0],
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get user stats');
      throw error;
    }
  }

  /**
   * Get user subscriptions
   * @param userId User ID
   * @returns User subscriptions
   */
  @Cacheable({
    configKey: 'userSubscriptions',
    keyGenerator: (args) => args[0],
    tags: ['subscriptions'],
  })
  async getUserSubscriptions(userId: string): Promise<unknown[]> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT s.*, p.name as plan_name, p.description as plan_description
         FROM subscriptions s
         LEFT JOIN plans p ON s.plan_id = p.id
         WHERE s.user_id = $1
         ORDER BY s.created_at DESC`,
        [userId]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get user subscriptions');
      throw error;
    }
  }

  /**
   * Get subscription details
   * @param userId User ID
   * @param subscriptionId Subscription ID
   * @returns Subscription details
   */
  @Cacheable({
    configKey: 'subscriptionDetails',
    keyGenerator: (args) => `${args[0]}:${args[1]}`,
    tags: ['subscriptions'],
  })
  async getSubscriptionDetails(userId: string, subscriptionId: number): Promise<Record<string, unknown> | null> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT s.*, p.name as plan_name, p.description as plan_description,
                p.traffic_limit, p.device_limit
         FROM subscriptions s
         LEFT JOIN plans p ON s.plan_id = p.id
         WHERE s.id = $1 AND s.user_id = $2`,
        [subscriptionId, userId]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error({ error, userId, subscriptionId }, 'Failed to get subscription details');
      throw error;
    }
  }

  /**
   * Renew subscription
   * @param userId User ID
   * @param subscriptionId Subscription ID
   * @returns Renewal result
   */
  @InvalidateCache({
    keyGenerator: (args) => `user:subs:${args[0]}`,
  })
  async renewSubscription(userId: string, subscriptionId: number): Promise<{ success: boolean; message: string; subscription?: unknown }> {
    const pool = getPool();

    try {
      // Check if subscription belongs to user
      const checkResult = await pool.query(
        `SELECT id, status, expire_at FROM subscriptions WHERE id = $1 AND user_id = $2`,
        [subscriptionId, userId]
      );

      if (checkResult.rows.length === 0) {
        return { success: false, message: 'Subscription not found' };
      }

      const subscription = checkResult.rows[0];

      // In a real implementation, this would create a payment order
      // For now, return success with instructions
      return {
        success: true,
        message: 'Subscription can be renewed. Please proceed to payment.',
        subscription: {
          id: subscription.id,
          currentExpireAt: subscription.expire_at,
          status: subscription.status,
        }
      };
    } catch (error) {
      logger.error({ error, userId, subscriptionId }, 'Failed to renew subscription');
      throw error;
    }
  }

  /**
   * Get subscription QR code data
   * @param userId User ID
   * @param subscriptionId Subscription ID
   * @returns QR code data
   */
  @Cacheable({
    configKey: 'qrCode',
    keyGenerator: (args) => `${args[0]}:${args[1]}`,
    tags: ['qr'],
  })
  async getSubscriptionQR(userId: string, subscriptionId: number): Promise<{ qrData: string; subscriptionUrl: string } | null> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT s.subscription_url, s.uuid
         FROM subscriptions s
         WHERE s.id = $1 AND s.user_id = $2 AND s.status = 'active'`,
        [subscriptionId, userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const subscription = result.rows[0];
      const subscriptionUrl = subscription.subscription_url;

      // QR data is typically the subscription URL or a specially formatted string
      return {
        qrData: subscriptionUrl,
        subscriptionUrl: subscriptionUrl,
      };
    } catch (error) {
      logger.error({ error, userId, subscriptionId }, 'Failed to get subscription QR');
      throw error;
    }
  }

  /**
   * Get available plans for user
   * @param userId User ID (for future use)
   * @returns Available plans
   */
  @Cacheable({
    configKey: 'plans',
    keyGenerator: () => 'active',
    tags: ['plans'],
  })
  async getAvailablePlans(userId: string): Promise<unknown[]> {
    void userId;
    const pool = getPool();

    try {
      // Get plans with their durations and prices
      const result = await pool.query(
        `SELECT p.*,
                json_agg(json_build_object(
                  'id', pd.id,
                  'days', pd.days,
                  'prices', (SELECT json_agg(json_build_object('currency', pp.currency, 'price', pp.price))
                             FROM plan_prices pp WHERE pp.plan_duration_id = pd.id)
                )) as durations
         FROM plans p
         LEFT JOIN plan_durations pd ON p.id = pd.plan_id
         WHERE p.is_active = true
         GROUP BY p.id
         ORDER BY p.order_index ASC`
      );

      return result.rows;
    } catch (error) {
      logger.error({ error }, 'Failed to get available plans');
      throw error;
    }
  }

  /**
   * Create payment
   * @param userId User ID
   * @param params Payment parameters
   * @returns Payment data
   */
  @InvalidateCache({
    keyGenerator: (args) => `user:subs:${args[0]}`,
  })
  async createPayment(
    userId: string,
    params: { planId: number; durationId: number; gatewayId: number }
  ): Promise<Record<string, unknown>> {
    const pool = getPool();
    const { planId, durationId, gatewayId } = params;

    try {
      // Get plan and duration details
      const planResult = await pool.query(
        `SELECT p.name, pd.days, pp.price, pp.currency, g.name as gateway_name
         FROM plans p
         JOIN plan_durations pd ON p.id = pd.plan_id
         JOIN plan_prices pp ON pd.id = pp.plan_duration_id
         JOIN gateways g ON g.id = $3
         WHERE p.id = $1 AND pd.id = $2 AND p.is_active = true`,
        [planId, durationId, gatewayId]
      );

      if (planResult.rows.length === 0) {
        throw new Error('Invalid plan, duration, or gateway');
      }

      const plan = planResult.rows[0];

      // Create payment record
      const paymentResult = await pool.query(
        `INSERT INTO transactions (user_id, plan_id, duration_id, gateway_id, amount, currency, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
         RETURNING *`,
        [userId, planId, durationId, gatewayId, plan.price, plan.currency]
      );

      const payment = paymentResult.rows[0];

      // TODO: Integrate with actual payment gateway
      // For now, return payment data with instructions
      return {
        paymentId: payment.id,
        amount: plan.price,
        currency: plan.currency,
        planName: plan.name,
        durationDays: plan.days,
        gatewayName: plan.gateway_name,
        status: 'pending',
        paymentUrl: `/payment/${payment.id}/pay`, // Placeholder
      };
    } catch (error) {
      logger.error({ error, userId, params }, 'Failed to create payment');
      throw error;
    }
  }

  /**
   * Get payment history
   * @param userId User ID
   * @param params Pagination params
   * @returns Payment history
   */
  @Cacheable({
    configKey: 'paymentHistory',
    keyGenerator: (args) => `${args[0]}:page:${(args[1] as { page: number }).page}:limit:${(args[1] as { limit: number }).limit}`,
    tags: ['payments'],
  })
  async getPaymentHistory(
    userId: string,
    params: { page: number; limit: number }
  ): Promise<{ items: unknown[]; total: number; page: number; limit: number }> {
    const pool = getPool();
    const { page, limit } = params;
    const offset = (page - 1) * limit;

    try {
      const [itemsResult, countResult] = await Promise.all([
        pool.query(
          `SELECT t.*, p.name as plan_name, g.name as gateway_name
           FROM transactions t
           LEFT JOIN plans p ON t.plan_id = p.id
           LEFT JOIN gateways g ON t.gateway_id = g.id
           WHERE t.user_id = $1
           ORDER BY t.created_at DESC
           LIMIT $2 OFFSET $3`,
          [userId, limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*) as total FROM transactions WHERE user_id = $1`,
          [userId]
        ),
      ]);

      return {
        items: itemsResult.rows,
        total: parseInt(countResult.rows[0].total, 10),
        page,
        limit,
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get payment history');
      throw error;
    }
  }

  /**
   * Get user referrals
   * @param userId User ID (referrer)
   * @returns Referrals list
   */
  @Cacheable({
    configKey: 'referralStats',
    keyGenerator: (args) => `list:${args[0]}`,
    tags: ['referrals'],
  })
  async getUserReferrals(userId: string): Promise<unknown[]> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT r.*, u.username as referred_username, u.first_name as referred_first_name
         FROM referrals r
         LEFT JOIN users u ON r.referred_id = u.id
         WHERE r.referrer_id = $1
         ORDER BY r.created_at DESC`,
        [userId]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get user referrals');
      throw error;
    }
  }

  /**
   * Get referral statistics
   * @param userId User ID
   * @returns Referral stats
   */
  @Cacheable({
    configKey: 'referralStats',
    keyGenerator: (args) => `stats:${args[0]}`,
    tags: ['referrals', 'stats'],
  })
  async getReferralStats(userId: string): Promise<Record<string, unknown>> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT
          COUNT(*) as total_referrals,
          COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as recent_referrals,
          COALESCE(SUM(points_earned), 0) as total_points_earned,
          COALESCE(SUM(CASE WHEN status = 'pending' THEN points_earned ELSE 0 END), 0) as pending_points
         FROM referrals
         WHERE referrer_id = $1`,
        [userId]
      );

      return result.rows[0];
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get referral stats');
      throw error;
    }
  }

  /**
   * Withdraw referral points
   * @param userId User ID
   * @param amount Amount to withdraw
   * @returns Withdrawal result
   */
  @InvalidateCache({
    keyGenerator: (args) => `ref:stats:${args[0]}`,
  })
  async withdrawReferralPoints(userId: string, amount: number): Promise<{ success: boolean; message: string; remainingPoints?: number }> {
    const pool = getPool();

    try {
      // Check available points
      const pointsResult = await pool.query(
        `SELECT COALESCE(SUM(points_earned), 0) as total_points
         FROM referrals
         WHERE referrer_id = $1 AND status = 'completed'`,
        [userId]
      );

      const availablePoints = parseInt(pointsResult.rows[0].total_points, 10);

      if (availablePoints < amount) {
        return { success: false, message: 'Insufficient points' };
      }

      // In a real implementation, this would:
      // 1. Create a withdrawal request
      // 2. Add days to subscription or convert to discount
      // For now, return success
      return {
        success: true,
        message: `Withdrawal of ${amount} points initiated`,
        remainingPoints: availablePoints - amount,
      };
    } catch (error) {
      logger.error({ error, userId, amount }, 'Failed to withdraw referral points');
      throw error;
    }
  }

  /**
   * Get partner data
   * @param userId User ID
   * @returns Partner data
   */
  @Cacheable({
    configKey: 'partnerStats',
    keyGenerator: (args) => `data:${args[0]}`,
    tags: ['partner'],
  })
  async getPartnerData(userId: string): Promise<Record<string, unknown> | null> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT p.*,
                COUNT(DISTINCT pe.id) as total_earnings_count,
                COALESCE(SUM(pe.amount), 0) as total_earned,
                COALESCE(SUM(CASE WHEN po.status = 'pending' THEN po.amount ELSE 0 END), 0) as pending_payouts
         FROM partners p
         LEFT JOIN partner_earnings pe ON p.id = pe.partner_id
         LEFT JOIN partner_payouts po ON p.id = po.partner_id
         WHERE p.user_id = $1
         GROUP BY p.id`,
        [userId]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get partner data');
      throw error;
    }
  }

  /**
   * Request partner payout
   * @param userId User ID
   * @param params Payout params
   * @returns Payout request result
   */
  @InvalidateCache({
    keyGenerator: (args) => `partner:stats:${args[0]}`,
  })
  async requestPayout(
    userId: string,
    params: { amount: number; method: string; requisites: string }
  ): Promise<{ success: boolean; message: string; newBalance?: number }> {
    const pool = getPool();
    const { amount, method, requisites } = params;

    try {
      // Get partner record
      const partnerResult = await pool.query(
        `SELECT id, balance FROM partners WHERE user_id = $1`,
        [userId]
      );

      if (partnerResult.rows.length === 0) {
        return { success: false, message: 'Partner account not found' };
      }

      const partner = partnerResult.rows[0];

      if (parseFloat(partner.balance) < amount) {
        return { success: false, message: 'Insufficient balance' };
      }

      // Create payout request
      await pool.query(
        `INSERT INTO partner_payouts (partner_id, amount, method, requisites, status, created_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [partner.id, amount, method, requisites]
      );

      // Update partner balance
      await pool.query(
        `UPDATE partners SET balance = balance - $1, updated_at = NOW() WHERE id = $2`,
        [amount, partner.id]
      );

      return {
        success: true,
        message: 'Payout request created successfully',
        newBalance: parseFloat(partner.balance) - amount,
      };
    } catch (error) {
      logger.error({ error, userId, params }, 'Failed to request payout');
      throw error;
    }
  }

  /**
   * Get user notifications
   * @param userId User ID
   * @param params Filter params
   * @returns Notifications
   */
  @Cacheable({
    configKey: 'notifications',
    keyGenerator: (args) => `${args[0]}:page:${(args[1] as { page: number }).page}:unread:${(args[1] as { unreadOnly: boolean }).unreadOnly}`,
    tags: ['notifications'],
  })
  async getNotifications(
    userId: string,
    params: { page: number; limit: number; unreadOnly: boolean }
  ): Promise<{ items: unknown[]; total: number; unreadCount: number; page: number; limit: number }> {
    const pool = getPool();
    const { page, limit, unreadOnly } = params;
    const offset = (page - 1) * limit;

    try {
      let whereClause = 'WHERE user_id = $1';
      const queryParams: (string | number | boolean)[] = [userId];

      if (unreadOnly) {
        whereClause += ' AND is_read = false';
      }

      const [itemsResult, countResult, unreadResult] = await Promise.all([
        pool.query(
          `SELECT * FROM notifications
           ${whereClause}
           ORDER BY created_at DESC
           LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
          [...queryParams, limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*) as total FROM notifications ${whereClause}`,
          queryParams
        ),
        pool.query(
          `SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = false`,
          [userId]
        ),
      ]);

      return {
        items: itemsResult.rows,
        total: parseInt(countResult.rows[0].total, 10),
        unreadCount: parseInt(unreadResult.rows[0].count, 10),
        page,
        limit,
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get notifications');
      throw error;
    }
  }

  /**
   * Mark notification as read
   * @param userId User ID
   * @param notificationId Notification ID
   * @returns Result
   */
  @InvalidateCache({
    keyGenerator: (args) => `notifications:${args[0]}*`,
  })
  async markNotificationAsRead(userId: string, notificationId: number): Promise<{ success: boolean }> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `UPDATE notifications
         SET is_read = true, read_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [notificationId, userId]
      );

      return { success: result.rows.length > 0 };
    } catch (error) {
      logger.error({ error, userId, notificationId }, 'Failed to mark notification as read');
      throw error;
    }
  }

  // ============================================================================
  // REFERRAL SYSTEM - DETAILED METHODS
  // ============================================================================

  /**
   * Get full referral information with levels
   * @param userId User ID
   * @returns Full referral info
   */
  @Cacheable({
    configKey: 'fullReferralInfo',
    keyGenerator: (args) => args[0],
    tags: ['referrals'],
  })
  async getFullReferralInfo(userId: string): Promise<Record<string, unknown>> {
    const pool = getPool();

    try {
      // Get basic stats
      const statsResult = await pool.query(
        `SELECT
          COUNT(*) as total_referrals,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_referrals,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_referrals,
          COALESCE(SUM(referrer_reward), 0) as total_earnings,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN referrer_reward ELSE 0 END), 0) as confirmed_earnings
         FROM referrals
         WHERE referrer_id = $1`,
        [userId]
      );

      // Get level statistics
      const levelsResult = await pool.query(
        `SELECT
          level,
          count,
          total_earnings,
          commission_rate
         FROM referral_levels
         WHERE user_id = $1
         ORDER BY level`,
        [userId]
      );

      // Get recent referrals
      const recentResult = await pool.query(
        `SELECT
          r.id,
          r.referred_id,
          r.status,
          r.referrer_reward,
          r.created_at,
          u.username as referred_username,
          u.first_name as referred_first_name,
          u.photo_url as referred_photo_url
         FROM referrals r
         LEFT JOIN users u ON r.referred_id = u.id
         WHERE r.referrer_id = $1
         ORDER BY r.created_at DESC
         LIMIT 10`,
        [userId]
      );

      return {
        stats: statsResult.rows[0],
        levels: levelsResult.rows,
        recentReferrals: recentResult.rows,
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get full referral info');
      throw error;
    }
  }

  /**
   * Get referral rules
   * @returns Referral rules
   */
  @Cacheable({
    configKey: 'referralRules',
    keyGenerator: () => 'active',
    tags: ['referrals', 'rules'],
  })
  async getReferralRules(): Promise<unknown[]> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT
          id,
          name,
          description,
          type,
          referrer_reward,
          referred_reward,
          min_purchase_amount,
          applies_to_plans,
          is_active,
          start_date,
          end_date
         FROM referral_rules
         WHERE is_active = true
         AND (start_date IS NULL OR start_date <= NOW())
         AND (end_date IS NULL OR end_date >= NOW())
         ORDER BY created_at DESC`
      );

      return result.rows;
    } catch (error) {
      logger.error({ error }, 'Failed to get referral rules');
      throw error;
    }
  }

  /**
   * Get referral history
   * @param userId User ID
   * @param params Pagination params
   * @returns Referral history
   */
  @Cacheable({
    configKey: 'referralStats',
    keyGenerator: (args) => `${args[0]}:history:page:${(args[1] as { page: number }).page}`,
    tags: ['referrals', 'history'],
  })
  async getReferralHistory(
    userId: string,
    params: { page: number; limit: number }
  ): Promise<{ items: unknown[]; total: number; page: number; limit: number }> {
    const pool = getPool();
    const { page, limit } = params;
    const offset = (page - 1) * limit;

    try {
      const [itemsResult, countResult] = await Promise.all([
        pool.query(
          `SELECT
            re.id,
            re.amount,
            re.type,
            re.level,
            re.description,
            re.status,
            re.created_at,
            re.paid_at,
            r.referred_id,
            u.username as referred_username,
            u.first_name as referred_first_name
           FROM referral_earnings re
           LEFT JOIN referrals r ON re.referral_id = r.id
           LEFT JOIN users u ON r.referred_id = u.id
           WHERE re.user_id = $1
           ORDER BY re.created_at DESC
           LIMIT $2 OFFSET $3`,
          [userId, limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*) as total FROM referral_earnings WHERE user_id = $1`,
          [userId]
        ),
      ]);

      return {
        items: itemsResult.rows,
        total: parseInt(countResult.rows[0].total, 10),
        page,
        limit,
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get referral history');
      throw error;
    }
  }

  /**
   * Get referral levels
   * @param userId User ID
   * @returns Referral levels
   */
  @Cacheable({
    configKey: 'referralLevels',
    keyGenerator: (args) => args[0],
    tags: ['referrals', 'levels'],
  })
  async getReferralLevels(userId: string): Promise<unknown[]> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT
          level,
          count,
          total_earnings,
          commission_rate,
          updated_at
         FROM referral_levels
         WHERE user_id = $1
         ORDER BY level`,
        [userId]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get referral levels');
      throw error;
    }
  }

  /**
   * Get top referrers
   * @param limit Number of top referrers
   * @returns Top referrers
   */
  @Cacheable({
    configKey: 'topReferrers',
    keyGenerator: (args) => `limit:${args[0]}`,
    tags: ['referrals', 'top'],
  })
  async getTopReferrers(limit: number): Promise<unknown[]> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT
          tr.user_id,
          tr.referral_count,
          tr.total_rewards,
          tr.rank,
          u.username,
          u.first_name,
          u.photo_url
         FROM top_referrers tr
         LEFT JOIN users u ON tr.user_id = u.id
         WHERE tr.period_type = 'monthly'
         AND tr.period_start >= DATE_TRUNC('month', NOW())
         ORDER BY tr.rank ASC
         LIMIT $1`,
        [limit]
      );

      // If no cached data, calculate from referrals
      if (result.rows.length === 0) {
        const calcResult = await pool.query(
          `SELECT
            r.referrer_id as user_id,
            COUNT(*) as referral_count,
            COALESCE(SUM(r.referrer_reward), 0) as total_rewards,
            u.username,
            u.first_name,
            u.photo_url
           FROM referrals r
           LEFT JOIN users u ON r.referrer_id = u.id
           WHERE r.status = 'completed'
           GROUP BY r.referrer_id, u.username, u.first_name, u.photo_url
           ORDER BY referral_count DESC
           LIMIT $1`,
          [limit]
        );
        return calcResult.rows;
      }

      return result.rows;
    } catch (error) {
      logger.error({ error }, 'Failed to get top referrers');
      throw error;
    }
  }

  /**
   * Exchange points for rewards
   * @param userId User ID
   * @param type Exchange type
   * @param amount Amount to exchange
   * @returns Exchange result
   */
  @InvalidateCache({
    keyGenerator: (args) => `ref:*:${args[0]}`,
  })
  async exchangePoints(
    userId: string,
    type: string,
    amount: number
  ): Promise<{ success: boolean; message: string; reward?: unknown }> {
    const pool = getPool();

    try {
      // Check available points
      const pointsResult = await pool.query(
        `SELECT COALESCE(SUM(referrer_reward), 0) as total_points
         FROM referrals
         WHERE referrer_id = $1 AND status = 'completed'`,
        [userId]
      );

      const availablePoints = parseFloat(pointsResult.rows[0].total_points);

      if (availablePoints < amount) {
        return { success: false, message: 'Insufficient points' };
      }

      // Validate exchange type
      const validTypes = ['subscription', 'discount', 'traffic'];
      if (!validTypes.includes(type)) {
        return { success: false, message: 'Invalid exchange type' };
      }

      // Calculate reward value based on type and amount
      let rewardValue: string;
      let rewardDescription: string;

      switch (type) {
        case 'subscription': {
          const days = Math.floor(amount / 10); // 10 points = 1 day
          rewardValue = JSON.stringify({ days });
          rewardDescription = `${days} дней подписки`;
          break;
        }
        case 'discount': {
          const discountPercent = Math.min(Math.floor(amount / 5), 50); // 5 points = 1%, max 50%
          rewardValue = JSON.stringify({ percent: discountPercent });
          rewardDescription = `Скидка ${discountPercent}%`;
          break;
        }
        case 'traffic': {
          const trafficGb = Math.floor(amount / 20); // 20 points = 1 GB
          rewardValue = JSON.stringify({ gb: trafficGb });
          rewardDescription = `${trafficGb} ГБ трафика`;
          break;
        }
        default:
          rewardValue = '{}';
          rewardDescription = '';
      }

      // Create exchange record
      await pool.query(
        `INSERT INTO referral_points_exchange
         (user_id, points_amount, exchange_type, reward_value, reward_description, status)
         VALUES ($1, $2, $3, $4, $5, 'completed')`,
        [userId, amount, type, rewardValue, rewardDescription]
      );

      return {
        success: true,
        message: 'Points exchanged successfully',
        reward: {
          type,
          description: rewardDescription,
          value: rewardValue,
        }
      };
    } catch (error) {
      logger.error({ error, userId, type, amount }, 'Failed to exchange points');
      throw error;
    }
  }

  // ============================================================================
  // PARTNER SYSTEM - DETAILED METHODS
  // ============================================================================

  /**
   * Get full partner statistics
   * @param userId User ID
   * @returns Full partner stats
   */
  @Cacheable({
    configKey: 'fullPartnerStats',
    keyGenerator: (args) => args[0],
    tags: ['partner'],
  })
  async getFullPartnerStats(userId: string): Promise<Record<string, unknown> | null> {
    const pool = getPool();

    try {
      // Get partner basic info
      const partnerResult = await pool.query(
        `SELECT
          p.id,
          p.user_id,
          p.commission_rate,
          p.total_earnings,
          p.paid_earnings,
          p.pending_earnings,
          p.referral_code,
          p.referral_count,
          p.status,
          p.created_at
         FROM partners p
         WHERE p.user_id = $1`,
        [userId]
      );

      if (partnerResult.rows.length === 0) {
        return null;
      }

      const partner = partnerResult.rows[0];

      // Get current level
      const levelResult = await pool.query(
        `SELECT
          pl.*
         FROM partner_levels pl
         WHERE pl.min_referrals <= $1
         AND pl.min_earnings <= $2
         AND pl.is_active = true
         ORDER BY pl.display_order DESC
         LIMIT 1`,
        [partner.referral_count, partner.total_earnings]
      );

      // Get next level
      const nextLevelResult = await pool.query(
        `SELECT
          pl.*
         FROM partner_levels pl
         WHERE pl.min_referrals > $1
         AND pl.is_active = true
         ORDER BY pl.display_order ASC
         LIMIT 1`,
        [partner.referral_count]
      );

      // Get 30-day stats
      const thirtyDaysResult = await pool.query(
        `SELECT
          COALESCE(SUM(clicks), 0) as total_clicks,
          COALESCE(SUM(conversions), 0) as total_conversions,
          COALESCE(SUM(earnings), 0) as total_earnings,
          CASE
            WHEN SUM(clicks) > 0 THEN ROUND((SUM(conversions)::numeric / SUM(clicks) * 100), 2)
            ELSE 0
          END as conversion_rate
         FROM partner_conversion
         WHERE partner_id = $1
         AND date >= NOW() - INTERVAL '30 days'`,
        [partner.id]
      );

      // Get earnings by status
      const earningsByStatus = await pool.query(
        `SELECT
          status,
          COUNT(*) as count,
          COALESCE(SUM(amount), 0) as total
         FROM partner_earnings
         WHERE partner_id = $1
         GROUP BY status`,
        [partner.id]
      );

      return {
        partner,
        currentLevel: levelResult.rows[0] || null,
        nextLevel: nextLevelResult.rows[0] || null,
        thirtyDaysStats: thirtyDaysResult.rows[0],
        earningsByStatus: earningsByStatus.rows,
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get full partner stats');
      throw error;
    }
  }

  /**
   * Get partner earnings history
   * @param userId User ID
   * @param params Pagination params
   * @returns Earnings history
   */
  @Cacheable({
    configKey: 'partnerStats',
    keyGenerator: (args) => `${args[0]}:earnings:page:${(args[1] as { page: number }).page}`,
    tags: ['partner', 'earnings'],
  })
  async getPartnerEarningsHistory(
    userId: string,
    params: { page: number; limit: number }
  ): Promise<{ items: unknown[]; total: number; page: number; limit: number }> {
    const pool = getPool();
    const { page, limit } = params;
    const offset = (page - 1) * limit;

    try {
      // Get partner id
      const partnerResult = await pool.query(
        `SELECT id FROM partners WHERE user_id = $1`,
        [userId]
      );

      if (partnerResult.rows.length === 0) {
        return { items: [], total: 0, page, limit };
      }

      const partnerId = partnerResult.rows[0].id;

      const [itemsResult, countResult] = await Promise.all([
        pool.query(
          `SELECT
            pe.id,
            pe.amount,
            pe.commission_rate,
            pe.status,
            pe.created_at,
            pe.paid_at,
            u.username as referred_username,
            u.first_name as referred_first_name,
            s.plan_id,
            pl.name as plan_name
           FROM partner_earnings pe
           LEFT JOIN users u ON pe.referred_user_id = u.id
           LEFT JOIN subscriptions s ON pe.subscription_id = s.id
           LEFT JOIN plans pl ON s.plan_id = pl.id
           WHERE pe.partner_id = $1
           ORDER BY pe.created_at DESC
           LIMIT $2 OFFSET $3`,
          [partnerId, limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*) as total FROM partner_earnings WHERE partner_id = $1`,
          [partnerId]
        ),
      ]);

      return {
        items: itemsResult.rows,
        total: parseInt(countResult.rows[0].total, 10),
        page,
        limit,
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get partner earnings history');
      throw error;
    }
  }

  /**
   * Get partner payouts history
   * @param userId User ID
   * @param params Pagination params
   * @returns Payouts history
   */
  @Cacheable({
    configKey: 'partnerStats',
    keyGenerator: (args) => `${args[0]}:payouts:page:${(args[1] as { page: number }).page}`,
    tags: ['partner', 'payouts'],
  })
  async getPartnerPayoutsHistory(
    userId: string,
    params: { page: number; limit: number }
  ): Promise<{ items: unknown[]; total: number; page: number; limit: number }> {
    const pool = getPool();
    const { page, limit } = params;
    const offset = (page - 1) * limit;

    try {
      // Get partner id
      const partnerResult = await pool.query(
        `SELECT id FROM partners WHERE user_id = $1`,
        [userId]
      );

      if (partnerResult.rows.length === 0) {
        return { items: [], total: 0, page, limit };
      }

      const partnerId = partnerResult.rows[0].id;

      const [itemsResult, countResult] = await Promise.all([
        pool.query(
          `SELECT
            id,
            amount,
            method,
            status,
            transaction_id,
            notes,
            created_at,
            processed_at
           FROM partner_payouts
           WHERE partner_id = $1
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3`,
          [partnerId, limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*) as total FROM partner_payouts WHERE partner_id = $1`,
          [partnerId]
        ),
      ]);

      return {
        items: itemsResult.rows,
        total: parseInt(countResult.rows[0].total, 10),
        page,
        limit,
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get partner payouts history');
      throw error;
    }
  }

  /**
   * Get partner referral details
   * @param userId User ID
   * @param referralId Referral ID
   * @returns Referral details
   */
  async getPartnerReferralDetails(userId: string, referralId: string): Promise<Record<string, unknown> | null> {
    const pool = getPool();

    try {
      // Get partner id
      const partnerResult = await pool.query(
        `SELECT id FROM partners WHERE user_id = $1`,
        [userId]
      );

      if (partnerResult.rows.length === 0) {
        return null;
      }

      const partnerId = partnerResult.rows[0].id;

      const result = await pool.query(
        `SELECT
          prd.*,
          u.username,
          u.first_name,
          u.last_name,
          u.photo_url,
          u.created_at as user_created_at,
          (SELECT COUNT(*) FROM subscriptions WHERE user_id = prd.referred_user_id) as subscription_count,
          (SELECT COALESCE(SUM(amount), 0) FROM partner_earnings WHERE partner_id = $1 AND referred_user_id = prd.referred_user_id) as total_earned
         FROM partner_referral_details prd
         LEFT JOIN users u ON prd.referred_user_id = u.id
         WHERE prd.partner_id = $1
         AND prd.id = $2`,
        [partnerId, referralId]
      );

      return result.rows[0] || null;
    } catch (error) {
      logger.error({ error, userId, referralId }, 'Failed to get partner referral details');
      throw error;
    }
  }

  /**
   * Get referrals by level
   * @param userId User ID
   * @param level Referral level (optional)
   * @returns Referrals grouped by level
   */
  async getReferralsByLevel(userId: string, level?: number): Promise<unknown[]> {
    const pool = getPool();

    try {
      // Get partner id
      const partnerResult = await pool.query(
        `SELECT id FROM partners WHERE user_id = $1`,
        [userId]
      );

      if (partnerResult.rows.length === 0) {
        return [];
      }

      const partnerId = partnerResult.rows[0].id;

      let query = `
        SELECT
          prd.*,
          u.username,
          u.first_name,
          u.last_name,
          u.photo_url
         FROM partner_referral_details prd
         LEFT JOIN users u ON prd.referred_user_id = u.id
         WHERE prd.partner_id = $1
      `;

      const params: (string | number)[] = [partnerId];

      if (level) {
        query += ` AND prd.level = $2`;
        params.push(level);
      }

      query += ` ORDER BY prd.created_at DESC`;

      const result = await pool.query(query, params);

      return result.rows;
    } catch (error) {
      logger.error({ error, userId, level }, 'Failed to get referrals by level');
      throw error;
    }
  }

  /**
   * Get conversion statistics
   * @param userId User ID
   * @param days Number of days to look back
   * @returns Conversion stats
   */
  @Cacheable({
    configKey: 'conversionStats',
    keyGenerator: (args) => `${args[0]}:days:${args[1]}`,
    tags: ['partner', 'conversion'],
  })
  async getConversionStats(userId: string, days: number): Promise<Record<string, unknown>> {
    const pool = getPool();

    try {
      // Get partner id
      const partnerResult = await pool.query(
        `SELECT id FROM partners WHERE user_id = $1`,
        [userId]
      );

      if (partnerResult.rows.length === 0) {
        return {
          totalClicks: 0,
          totalConversions: 0,
          conversionRate: 0,
          earnings: 0,
          dailyStats: [],
        };
      }

      const partnerId = partnerResult.rows[0].id;

      // Get aggregated stats
      const statsResult = await pool.query(
        `SELECT
          COALESCE(SUM(clicks), 0) as total_clicks,
          COALESCE(SUM(unique_clicks), 0) as total_unique_clicks,
          COALESCE(SUM(conversions), 0) as total_conversions,
          COALESCE(SUM(earnings), 0) as total_earnings,
          CASE
            WHEN SUM(clicks) > 0 THEN ROUND((SUM(conversions)::numeric / SUM(clicks) * 100), 2)
            ELSE 0
          END as conversion_rate
         FROM partner_conversion
         WHERE partner_id = $1
         AND date >= NOW() - INTERVAL '${days} days'`,
        [partnerId]
      );

      // Get daily breakdown
      const dailyResult = await pool.query(
        `SELECT
          date,
          clicks,
          unique_clicks,
          conversions,
          conversion_rate,
          earnings
         FROM partner_conversion
         WHERE partner_id = $1
         AND date >= NOW() - INTERVAL '${days} days'
         ORDER BY date DESC`,
        [partnerId]
      );

      return {
        ...statsResult.rows[0],
        dailyStats: dailyResult.rows,
        periodDays: days,
      };
    } catch (error) {
      logger.error({ error, userId, days }, 'Failed to get conversion stats');
      throw error;
    }
  }

  // ============================================================================
  // LANGUAGE & TRANSLATION METHODS
  // ============================================================================

  /**
   * Get user language preference
   * @param userId User ID
   * @returns Language code
   */
  async getUserLanguage(userId: string): Promise<string> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT language FROM users WHERE id = $1`,
        [userId]
      );

      return result.rows[0]?.language || 'ru';
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get user language');
      throw error;
    }
  }

  /**
   * Update user language preference
   * @param userId User ID
   * @param language Language code (ru/en)
   * @returns Update result
   */
  @InvalidateCache({
    keyGenerator: (args) => `profile:${args[0]}`,
  })
  async updateUserLanguage(userId: string, language: string): Promise<{ success: boolean; language: string }> {
    const pool = getPool();

    try {
      await pool.query(
        `UPDATE users SET language = $1 WHERE id = $2`,
        [language, userId]
      );

      return { success: true, language };
    } catch (error) {
      logger.error({ error, userId, language }, 'Failed to update user language');
      throw error;
    }
  }

  /**
   * Get dynamic translations from database
   * @param lang Language code
   * @returns Translations object
   */
  @Cacheable({
    configKey: 'default',
    keyGenerator: (args) => `translations:${args[0]}`,
    tags: ['translations'],
  })
  async getTranslations(lang: string): Promise<Record<string, string>> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT key, ${lang} as value FROM translations`
      );

      const translations: Record<string, string> = {};
      for (const row of result.rows) {
        translations[row.key] = row.value;
      }

      return translations;
    } catch (error) {
      logger.error({ error, lang }, 'Failed to get translations');
      throw error;
    }
  }
}
