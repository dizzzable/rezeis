import { getPool } from '../../config/database.js';
import { logger } from '../../utils/logger.js';
import type { PoolClient } from 'pg';

/**
 * Partner settings interface
 */
export interface PartnerSettings {
  id: string;
  isEnabled: boolean;
  level1Percent: number;
  level2Percent: number;
  level3Percent: number;
  taxPercent: number;
  minPayoutAmount: number;
  paymentSystemFee: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Update settings DTO
 */
export interface UpdateSettingsDTO {
  isEnabled?: boolean;
  level1Percent?: number;
  level2Percent?: number;
  level3Percent?: number;
  taxPercent?: number;
  minPayoutAmount?: number;
  paymentSystemFee?: number;
}

/**
 * Partner interface
 */
export interface Partner {
  id: string;
  userId: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  isPartner: boolean;
  partnerActivatedAt: Date | null;
  partnerActivatedBy: string | null;
  partnerNotes: string | null;
  balance: number;
  totalEarnings: number;
  referralCount: number;
  createdAt: Date;
}

/**
 * Paginated partners result
 */
export interface PaginatedPartners {
  items: Partner[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Partner stats interface
 */
export interface PartnerStats {
  userId: string;
  totalEarnings: number;
  pendingEarnings: number;
  paidEarnings: number;
  referralCount: number;
  activeReferrals: number;
  conversionRate: number;
  totalClicks: number;
  totalConversions: number;
}

/**
 * Payout request interface
 */
export interface PayoutRequest {
  id: string;
  partnerId: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected' | 'completed';
  paymentMethod: string;
  paymentDetails: Record<string, unknown>;
  notes: string | null;
  processedBy: string | null;
  processedAt: Date | null;
  createdAt: Date;
}

/**
 * Paginated payouts result
 */
export interface PaginatedPayouts {
  items: PayoutRequest[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Partner service for hidden partner program
 * Handles partner activation, settings, payouts, and statistics
 */
export class PartnerService {
  /**
   * Activate partner status for a user (admin only)
   * @param userId - User ID to activate
   * @param adminId - Admin ID performing the activation
   * @param notes - Optional notes
   * @returns Updated partner info
   */
  async activatePartner(userId: string, adminId: string, notes?: string): Promise<Partner> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check if user exists
      const userCheck = await client.query(
        `SELECT id, username, first_name, last_name, photo_url, is_partner 
         FROM users WHERE id = $1`,
        [userId]
      );

      if (userCheck.rows.length === 0) {
        throw new Error('User not found');
      }

      const user = userCheck.rows[0];

      if (user.is_partner) {
        throw new Error('User is already a partner');
      }

      // Update user as partner
      const updateResult = await client.query(
        `UPDATE users 
         SET is_partner = TRUE, 
             partner_activated_at = NOW(), 
             partner_activated_by = $2,
             partner_notes = COALESCE($3, partner_notes)
         WHERE id = $1
         RETURNING *`,
        [userId, adminId, notes]
      );

      // Create partner record if not exists
      const partnerCheck = await client.query(
        `SELECT id FROM partners WHERE user_id = $1`,
        [userId]
      );

      if (partnerCheck.rows.length === 0) {
        // Generate unique referral code
        const referralCode = await this.generateReferralCode(client, user.username);

        await client.query(
          `INSERT INTO partners (user_id, referral_code, status, created_at, updated_at)
           VALUES ($1, $2, 'active', NOW(), NOW())`,
          [userId, referralCode]
        );
      } else {
        // Update existing partner to active
        await client.query(
          `UPDATE partners SET status = 'active', updated_at = NOW() WHERE user_id = $1`,
          [userId]
        );
      }

      // Log activation
      await client.query(
        `INSERT INTO partner_activation_log (user_id, action, performed_by, notes, created_at)
         VALUES ($1, 'activated', $2, $3, NOW())`,
        [userId, adminId, notes]
      );

      await client.query('COMMIT');

      logger.info({ userId, adminId }, 'Partner activated successfully');

      return this.mapToPartner(updateResult.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, userId, adminId }, 'Failed to activate partner');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Deactivate partner status for a user (admin only)
   * @param userId - User ID to deactivate
   * @param adminId - Admin ID performing the deactivation
   * @param reason - Optional reason
   * @returns Updated partner info
   */
  async deactivatePartner(userId: string, adminId: string, reason?: string): Promise<Partner> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check if user exists and is partner
      const userCheck = await client.query(
        `SELECT id, is_partner FROM users WHERE id = $1`,
        [userId]
      );

      if (userCheck.rows.length === 0) {
        throw new Error('User not found');
      }

      if (!userCheck.rows[0].is_partner) {
        throw new Error('User is not a partner');
      }

      // Update user
      const updateResult = await client.query(
        `UPDATE users 
         SET is_partner = FALSE,
             partner_notes = COALESCE($2, partner_notes)
         WHERE id = $1
         RETURNING *`,
        [userId, reason ? `Deactivated: ${reason}` : null]
      );

      // Update partner status
      await client.query(
        `UPDATE partners SET status = 'suspended', updated_at = NOW() WHERE user_id = $1`,
        [userId]
      );

      // Log deactivation
      await client.query(
        `INSERT INTO partner_activation_log (user_id, action, performed_by, notes, created_at)
         VALUES ($1, 'deactivated', $2, $3, NOW())`,
        [userId, adminId, reason]
      );

      await client.query('COMMIT');

      logger.info({ userId, adminId, reason }, 'Partner deactivated successfully');

      return this.mapToPartner(updateResult.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, userId, adminId }, 'Failed to deactivate partner');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Check if user is a partner
   * @param userId - User ID
   * @returns True if user is partner
   */
  async isPartner(userId: string): Promise<boolean> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT is_partner FROM users WHERE id = $1`,
        [userId]
      );

      return result.rows.length > 0 && result.rows[0].is_partner === true;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to check partner status');
      throw error;
    }
  }

  /**
   * Get all partners with pagination and search
   * @param options - Query options
   * @returns Paginated partners
   */
  async getAllPartners(options: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<PaginatedPartners> {
    const pool = getPool();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    try {
      let whereClause = 'WHERE u.is_partner = TRUE';
      const params: (string | number)[] = [];

      if (options.search) {
        whereClause += ` AND (
          u.username ILIKE $${params.length + 1} 
          OR u.first_name ILIKE $${params.length + 1}
          OR u.last_name ILIKE $${params.length + 1}
        )`;
        params.push(`%${options.search}%`);
      }

      const [itemsResult, countResult] = await Promise.all([
        pool.query(
          `SELECT 
            u.id, u.username, u.first_name, u.last_name, u.photo_url,
            u.is_partner, u.partner_activated_at, u.partner_activated_by, u.partner_notes, u.created_at,
            p.balance, p.total_earnings, p.referral_count,
            au.username as activated_by_username
           FROM users u
           LEFT JOIN partners p ON u.id = p.user_id
           LEFT JOIN users au ON u.partner_activated_by = au.id
           ${whereClause}
           ORDER BY u.partner_activated_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*) as total FROM users u ${whereClause}`,
          params
        ),
      ]);

      return {
        items: itemsResult.rows.map(row => this.mapToPartner(row)),
        total: parseInt(countResult.rows[0].total, 10),
        page,
        limit,
      };
    } catch (error) {
      logger.error({ error, options }, 'Failed to get all partners');
      throw error;
    }
  }

  /**
   * Get partner statistics
   * @param userId - User ID
   * @returns Partner stats
   */
  async getPartnerStats(userId: string): Promise<PartnerStats> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT 
          p.user_id,
          COALESCE(p.total_earnings, 0) as total_earnings,
          COALESCE(p.pending_earnings, 0) as pending_earnings,
          COALESCE(p.paid_earnings, 0) as paid_earnings,
          COALESCE(p.referral_count, 0) as referral_count,
          COUNT(DISTINCT r.id) as active_referrals,
          COALESCE(AVG(pc.conversion_rate), 0) as conversion_rate,
          COALESCE(SUM(pc.clicks), 0) as total_clicks,
          COALESCE(SUM(pc.conversions), 0) as total_conversions
         FROM partners p
         LEFT JOIN referrals r ON r.referrer_id = p.user_id AND r.status = 'active'
         LEFT JOIN partner_conversion pc ON pc.partner_id = p.id AND pc.date >= NOW() - INTERVAL '30 days'
         WHERE p.user_id = $1
         GROUP BY p.id, p.user_id`,
        [userId]
      );

      if (result.rows.length === 0) {
        return {
          userId,
          totalEarnings: 0,
          pendingEarnings: 0,
          paidEarnings: 0,
          referralCount: 0,
          activeReferrals: 0,
          conversionRate: 0,
          totalClicks: 0,
          totalConversions: 0,
        };
      }

      const row = result.rows[0];
      return {
        userId: row.user_id,
        totalEarnings: parseFloat(row.total_earnings),
        pendingEarnings: parseFloat(row.pending_earnings),
        paidEarnings: parseFloat(row.paid_earnings),
        referralCount: parseInt(row.referral_count, 10),
        activeReferrals: parseInt(row.active_referrals, 10),
        conversionRate: parseFloat(row.conversion_rate),
        totalClicks: parseInt(row.total_clicks, 10),
        totalConversions: parseInt(row.total_conversions, 10),
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get partner stats');
      throw error;
    }
  }

  /**
   * Add commission to partner
   * @param partnerId - Partner ID
   * @param fromUserId - User who made the payment
   * @param amount - Commission amount
   * @param level - Referral level (1-3)
   */
  async addCommission(
    partnerId: string,
    fromUserId: string,
    amount: number,
    level: number
  ): Promise<void> {
    const pool = getPool();

    try {
      const settings = await this.getSettings();
      let commissionPercent = settings.level1Percent;
      if (level === 2) commissionPercent = settings.level2Percent;
      if (level === 3) commissionPercent = settings.level3Percent;

      const commissionAmount = amount * (commissionPercent / 100);

      await pool.query(
        `INSERT INTO partner_commission_earnings 
         (partner_id, from_user_id, amount, commission_percent, level, status, created_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', NOW())`,
        [partnerId, fromUserId, commissionAmount, commissionPercent, level]
      );

      // Update partner pending earnings
      await pool.query(
        `UPDATE partners 
         SET pending_earnings = pending_earnings + $1,
             total_earnings = total_earnings + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [commissionAmount, partnerId]
      );

      logger.info({ partnerId, fromUserId, amount, level }, 'Commission added to partner');
    } catch (error) {
      logger.error({ error, partnerId, fromUserId, amount }, 'Failed to add commission');
      throw error;
    }
  }

  /**
   * Create payout request
   * @param partnerId - Partner ID
   * @param amount - Amount to withdraw
   * @param paymentMethod - Payment method
   * @param paymentDetails - Payment details
   * @returns Created payout request
   */
  async requestPayout(
    partnerId: string,
    amount: number,
    paymentMethod: string,
    paymentDetails: Record<string, unknown>
  ): Promise<PayoutRequest> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check partner balance
      const partnerResult = await client.query(
        `SELECT balance FROM partners WHERE id = $1`,
        [partnerId]
      );

      if (partnerResult.rows.length === 0) {
        throw new Error('Partner not found');
      }

      const balance = parseFloat(partnerResult.rows[0].balance);

      if (balance < amount) {
        throw new Error('Insufficient balance');
      }

      // Check minimum payout
      const settings = await this.getSettings();
      if (amount < settings.minPayoutAmount) {
        throw new Error(`Minimum payout amount is ${settings.minPayoutAmount}`);
      }

      // Create payout request
      const payoutResult = await client.query(
        `INSERT INTO partner_payouts 
         (partner_id, amount, status, payment_method, payment_details, created_at, updated_at)
         VALUES ($1, $2, 'pending', $3, $4, NOW(), NOW())
         RETURNING *`,
        [partnerId, amount, paymentMethod, JSON.stringify(paymentDetails)]
      );

      // Reserve balance
      await client.query(
        `UPDATE partners 
         SET balance = balance - $1,
             pending_earnings = pending_earnings - $1,
             updated_at = NOW()
         WHERE id = $2`,
        [amount, partnerId]
      );

      await client.query('COMMIT');

      logger.info({ partnerId, amount, paymentMethod }, 'Payout request created');

      return this.mapToPayoutRequest(payoutResult.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, partnerId, amount }, 'Failed to create payout request');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Process payout request (admin only)
   * @param payoutId - Payout ID
   * @param adminId - Admin ID
   * @param status - New status
   * @param notes - Optional notes
   * @returns Updated payout request
   */
  async processPayout(
    payoutId: string,
    adminId: string,
    status: 'approved' | 'rejected' | 'completed',
    notes?: string
  ): Promise<PayoutRequest> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get payout details
      const payoutResult = await client.query(
        `SELECT * FROM partner_payouts WHERE id = $1`,
        [payoutId]
      );

      if (payoutResult.rows.length === 0) {
        throw new Error('Payout not found');
      }

      const payout = payoutResult.rows[0];

      if (payout.status !== 'pending') {
        throw new Error('Payout has already been processed');
      }

      // Update payout status
      const updateResult = await client.query(
        `UPDATE partner_payouts 
         SET status = $1, 
             processed_by = $2, 
             processed_at = NOW(),
             notes = COALESCE($3, notes),
             updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [status, adminId, notes, payoutId]
      );

      // If rejected, return balance to partner
      if (status === 'rejected') {
        await client.query(
          `UPDATE partners 
           SET balance = balance + $1,
               pending_earnings = pending_earnings + $1,
               updated_at = NOW()
           WHERE id = $2`,
          [payout.amount, payout.partner_id]
        );
      }

      // If approved or completed, add to paid earnings
      if (status === 'approved' || status === 'completed') {
        await client.query(
          `UPDATE partners 
           SET paid_earnings = paid_earnings + $1,
               updated_at = NOW()
           WHERE id = $2`,
          [payout.amount, payout.partner_id]
        );

        // Update commission earnings status
        await client.query(
          `UPDATE partner_commission_earnings 
           SET status = 'paid', paid_at = NOW()
           WHERE partner_id = $1 AND status = 'pending'
           LIMIT $2`,
          [payout.partner_id, Math.ceil(payout.amount / 10)] // Approximate number of earnings to mark as paid
        );
      }

      await client.query('COMMIT');

      logger.info({ payoutId, adminId, status }, 'Payout processed successfully');

      return this.mapToPayoutRequest(updateResult.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, payoutId, adminId, status }, 'Failed to process payout');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get all payouts with filters
   * @param options - Query options
   * @returns Paginated payouts
   */
  async getAllPayouts(options: {
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedPayouts> {
    const pool = getPool();
    const page = options.page || 1;
    const limit = options.limit || 20;
    const offset = (page - 1) * limit;

    try {
      let whereClause = 'WHERE 1=1';
      const params: (string | number)[] = [];

      if (options.status) {
        whereClause += ` AND pp.status = $${params.length + 1}`;
        params.push(options.status);
      }

      const [itemsResult, countResult] = await Promise.all([
        pool.query(
          `SELECT 
            pp.*,
            p.user_id,
            u.username,
            u.first_name,
            u.last_name,
            au.username as processed_by_username
           FROM partner_payouts pp
           JOIN partners p ON pp.partner_id = p.id
           JOIN users u ON p.user_id = u.id
           LEFT JOIN users au ON pp.processed_by = au.id
           ${whereClause}
           ORDER BY pp.created_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        pool.query(
          `SELECT COUNT(*) as total 
           FROM partner_payouts pp
           JOIN partners p ON pp.partner_id = p.id
           ${whereClause}`,
          params
        ),
      ]);

      return {
        items: itemsResult.rows.map(row => this.mapToPayoutRequest(row)),
        total: parseInt(countResult.rows[0].total, 10),
        page,
        limit,
      };
    } catch (error) {
      logger.error({ error, options }, 'Failed to get all payouts');
      throw error;
    }
  }

  /**
   * Get partner settings
   * @returns Partner settings
   */
  async getSettings(): Promise<PartnerSettings> {
    const pool = getPool();

    try {
      const result = await pool.query(`SELECT * FROM partner_settings LIMIT 1`);

      if (result.rows.length === 0) {
        // Create default settings
        const insertResult = await pool.query(
          `INSERT INTO partner_settings (is_enabled, level1_percent, level2_percent, level3_percent)
           VALUES (FALSE, 10.00, 5.00, 2.00)
           RETURNING *`
        );
        return this.mapToSettings(insertResult.rows[0]);
      }

      return this.mapToSettings(result.rows[0]);
    } catch (error) {
      logger.error({ error }, 'Failed to get partner settings');
      throw error;
    }
  }

  /**
   * Update partner settings (admin only)
   * @param adminId - Admin ID
   * @param settings - Settings to update
   * @returns Updated settings
   */
  async updateSettings(adminId: string, settings: UpdateSettingsDTO): Promise<PartnerSettings> {
    const pool = getPool();

    try {
      const currentSettings = await this.getSettings();

      const updates: string[] = [];
      const values: (boolean | number | string)[] = [];
      let paramIndex = 1;

      if (settings.isEnabled !== undefined) {
        updates.push(`is_enabled = $${paramIndex++}`);
        values.push(settings.isEnabled);
      }
      if (settings.level1Percent !== undefined) {
        updates.push(`level1_percent = $${paramIndex++}`);
        values.push(settings.level1Percent);
      }
      if (settings.level2Percent !== undefined) {
        updates.push(`level2_percent = $${paramIndex++}`);
        values.push(settings.level2Percent);
      }
      if (settings.level3Percent !== undefined) {
        updates.push(`level3_percent = $${paramIndex++}`);
        values.push(settings.level3Percent);
      }
      if (settings.taxPercent !== undefined) {
        updates.push(`tax_percent = $${paramIndex++}`);
        values.push(settings.taxPercent);
      }
      if (settings.minPayoutAmount !== undefined) {
        updates.push(`min_payout_amount = $${paramIndex++}`);
        values.push(settings.minPayoutAmount);
      }
      if (settings.paymentSystemFee !== undefined) {
        updates.push(`payment_system_fee = $${paramIndex++}`);
        values.push(settings.paymentSystemFee);
      }

      if (updates.length === 0) {
        return currentSettings;
      }

      const result = await pool.query(
        `UPDATE partner_settings 
         SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${paramIndex}
         RETURNING *`,
        [...values, currentSettings.id]
      );

      logger.info({ adminId, settings }, 'Partner settings updated');

      return this.mapToSettings(result.rows[0]);
    } catch (error) {
      logger.error({ error, adminId, settings }, 'Failed to update partner settings');
      throw error;
    }
  }

  /**
   * Get partner activation history
   * @param userId - User ID
   * @returns Activation log entries
   */
  async getActivationHistory(userId: string): Promise<unknown[]> {
    const pool = getPool();

    try {
      const result = await pool.query(
        `SELECT 
          pal.*,
          u.username as performed_by_username
         FROM partner_activation_log pal
         JOIN users u ON pal.performed_by = u.id
         WHERE pal.user_id = $1
         ORDER BY pal.created_at DESC`,
        [userId]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get activation history');
      throw error;
    }
  }

  /**
   * Generate unique referral code
   * @param client - Database client
   * @param username - Username base
   * @returns Unique referral code
   */
  private async generateReferralCode(client: PoolClient, username: string): Promise<string> {
    const base = username.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase();
    let code = base;
    let counter = 1;

    while (true) {
      const result = await client.query(
        `SELECT id FROM partners WHERE referral_code = $1`,
        [code]
      );

      if (result.rows.length === 0) {
        return code;
      }

      code = `${base}${counter}`;
      counter++;

      if (counter > 1000) {
        // Fallback to random
        code = `${base}${Math.random().toString(36).substring(2, 6)}`;
        return code;
      }
    }
  }

  /**
   * Map database row to Partner interface
   */
  private mapToPartner(row: Record<string, unknown>): Partner {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      username: row.username as string,
      firstName: row.first_name as string | null,
      lastName: row.last_name as string | null,
      photoUrl: row.photo_url as string | null,
      isPartner: row.is_partner as boolean,
      partnerActivatedAt: row.partner_activated_at ? new Date(row.partner_activated_at as string) : null,
      partnerActivatedBy: row.partner_activated_by as string | null,
      partnerNotes: row.partner_notes as string | null,
      balance: parseFloat((row.balance as string) || '0'),
      totalEarnings: parseFloat((row.total_earnings as string) || '0'),
      referralCount: parseInt((row.referral_count as string) || '0', 10),
      createdAt: new Date(row.created_at as string),
    };
  }

  /**
   * Map database row to PayoutRequest interface
   */
  private mapToPayoutRequest(row: Record<string, unknown>): PayoutRequest {
    return {
      id: row.id as string,
      partnerId: row.partner_id as string,
      amount: parseFloat(row.amount as string),
      status: row.status as 'pending' | 'approved' | 'rejected' | 'completed',
      paymentMethod: row.payment_method as string,
      paymentDetails: (row.payment_details as Record<string, unknown>) || {},
      notes: row.notes as string | null,
      processedBy: row.processed_by as string | null,
      processedAt: row.processed_at ? new Date(row.processed_at as string) : null,
      createdAt: new Date(row.created_at as string),
    };
  }

  /**
   * Map database row to PartnerSettings interface
   */
  private mapToSettings(row: Record<string, unknown>): PartnerSettings {
    return {
      id: row.id as string,
      isEnabled: row.is_enabled as boolean,
      level1Percent: parseFloat(row.level1_percent as string),
      level2Percent: parseFloat(row.level2_percent as string),
      level3Percent: parseFloat(row.level3_percent as string),
      taxPercent: parseFloat(row.tax_percent as string),
      minPayoutAmount: parseFloat(row.min_payout_amount as string),
      paymentSystemFee: parseFloat(row.payment_system_fee as string),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}

// Export singleton instance
export const partnerService = new PartnerService();
