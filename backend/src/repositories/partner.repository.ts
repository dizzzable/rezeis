import type { Pool, QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError } from './base.repository.js';
import type {
  Partner,
  PartnerEarning,
  PartnerPayout,
  CreatePartnerDto,
  UpdatePartnerDto,
  PartnerFilters,
  PayoutFilters,
  EarningFilters,
  PartnerStats,
  PayoutStatus,
  EarningStatus,
  PartnerStatus,
  PayoutMethod,
} from '../entities/partner.entity.js';
import { logger } from '../utils/logger.js';

/**
 * Partner Repository
 * Handles database operations for partners, earnings, and payouts
 */
export class PartnerRepository extends BaseRepository<Partner, CreatePartnerDto, UpdatePartnerDto> {
  protected readonly tableName = 'partners';

  constructor(db: Pool) {
    super(db);
  }

  /**
   * Map database row to Partner entity
   */
  protected mapRowToEntity(row: QueryResultRow): Partner {
    return {
      id: row.id,
      userId: row.user_id,
      commissionRate: parseFloat(row.commission_rate),
      totalEarnings: parseFloat(row.total_earnings),
      paidEarnings: parseFloat(row.paid_earnings),
      pendingEarnings: parseFloat(row.pending_earnings),
      referralCode: row.referral_code,
      referralCount: row.referral_count,
      payoutMethod: row.payout_method as PayoutMethod | null,
      payoutDetails: (row.payout_details as Record<string, unknown>) || {},
      status: row.status as PartnerStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find partner by user ID
   */
  async findByUserId(userId: string): Promise<Partner | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM ${this.tableName} WHERE user_id = $1`,
        [userId]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to find partner by user ID');
      throw new RepositoryError('Failed to find partner by user ID', error);
    }
  }

  /**
   * Find partner by referral code
   */
  async findByReferralCode(code: string): Promise<Partner | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM ${this.tableName} WHERE referral_code = $1`,
        [code]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, code }, 'Failed to find partner by referral code');
      throw new RepositoryError('Failed to find partner by referral code', error);
    }
  }

  /**
   * Find partners by status
   */
  async findByStatus(status: PartnerStatus, page = 1, limit = 10): Promise<{ data: Partner[]; total: number }> {
    try {
      const offset = (page - 1) * limit;
      
      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM ${this.tableName} WHERE status = $1`,
        [status]
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM ${this.tableName} WHERE status = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [status, limit, offset]
      );

      return {
        data: result.rows.map((row) => this.mapRowToEntity(row)),
        total,
      };
    } catch (error) {
      logger.error({ error, status }, 'Failed to find partners by status');
      throw new RepositoryError('Failed to find partners by status', error);
    }
  }

  /**
   * Search partners by user info
   */
  async searchPartners(query: string, page = 1, limit = 10): Promise<{ data: Partner[]; total: number }> {
    try {
      const offset = (page - 1) * limit;
      const searchPattern = `%${query}%`;

      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM ${this.tableName} p
         JOIN users u ON p.user_id = u.id
         WHERE u.username ILIKE $1 OR u.telegram_id ILIKE $1`,
        [searchPattern]
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const result = await this.db.query<QueryResultRow>(
        `SELECT p.* FROM ${this.tableName} p
         JOIN users u ON p.user_id = u.id
         WHERE u.username ILIKE $1 OR u.telegram_id ILIKE $1
         ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
        [searchPattern, limit, offset]
      );

      return {
        data: result.rows.map((row) => this.mapRowToEntity(row)),
        total,
      };
    } catch (error) {
      logger.error({ error, query }, 'Failed to search partners');
      throw new RepositoryError('Failed to search partners', error);
    }
  }

  /**
   * Find partners with filters
   */
  async findWithFilters(filters: PartnerFilters): Promise<{ data: Partner[]; total: number }> {
    try {
      const { status, search, page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = filters;
      const offset = (page - 1) * limit;

      let whereClause = '';
      const params: (string | number)[] = [];
      let paramIndex = 1;

      if (status) {
        whereClause += ` WHERE p.status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (search) {
        whereClause += whereClause ? ' AND' : ' WHERE';
        whereClause += ` (u.username ILIKE $${paramIndex} OR u.telegram_id ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM ${this.tableName} p
         JOIN users u ON p.user_id = u.id${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const columnMap: Record<string, string> = {
        createdAt: 'p.created_at',
        updatedAt: 'p.updated_at',
        totalEarnings: 'p.total_earnings',
        referralCount: 'p.referral_count',
      };
      const orderColumn = columnMap[sortBy as string] || 'p.created_at';

      const result = await this.db.query<QueryResultRow>(
        `SELECT p.* FROM ${this.tableName} p
         JOIN users u ON p.user_id = u.id${whereClause}
         ORDER BY ${orderColumn} ${sortOrder.toUpperCase()}
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
      );

      return {
        data: result.rows.map((row) => this.mapRowToEntity(row)),
        total,
      };
    } catch (error) {
      logger.error({ error, filters }, 'Failed to find partners with filters');
      throw new RepositoryError('Failed to find partners with filters', error);
    }
  }

  /**
   * Get partner statistics
   */
  async getPartnerStats(): Promise<PartnerStats> {
    try {
      const result = await this.db.query<QueryResultRow>(`
        SELECT
          COUNT(*) as total_partners,
          COUNT(*) FILTER (WHERE status = 'pending') as pending_partners,
          COUNT(*) FILTER (WHERE status = 'active') as active_partners,
          COUNT(*) FILTER (WHERE status = 'suspended') as suspended_partners,
          COALESCE(SUM(total_earnings), 0) as total_earnings,
          COALESCE(SUM(paid_earnings), 0) as total_paid,
          COALESCE(SUM(pending_earnings), 0) as total_pending,
          COALESCE(SUM(referral_count), 0) as total_referrals
        FROM ${this.tableName}
      `);

      const row = result.rows[0];
      return {
        totalPartners: parseInt(row.total_partners as string, 10),
        pendingPartners: parseInt(row.pending_partners as string, 10),
        activePartners: parseInt(row.active_partners as string, 10),
        suspendedPartners: parseInt(row.suspended_partners as string, 10),
        totalEarnings: parseFloat(row.total_earnings as string),
        totalPaid: parseFloat(row.total_paid as string),
        totalPending: parseFloat(row.total_pending as string),
        totalReferrals: parseInt(row.total_referrals as string, 10),
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get partner stats');
      throw new RepositoryError('Failed to get partner stats', error);
    }
  }

  /**
   * Update partner status
   */
  async updateStatus(id: string, status: PartnerStatus): Promise<Partner | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE ${this.tableName} SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [status, id]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, id, status }, 'Failed to update partner status');
      throw new RepositoryError('Failed to update partner status', error);
    }
  }

  /**
   * Create a partner earning
   */
  async createEarning(earning: Omit<PartnerEarning, 'id' | 'createdAt' | 'paidAt'>): Promise<PartnerEarning> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `INSERT INTO partner_earnings (partner_id, referred_user_id, subscription_id, amount, commission_rate, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [earning.partnerId, earning.referredUserId, earning.subscriptionId, earning.amount, earning.commissionRate, earning.status]
      );
      return this.mapToEarning(result.rows[0]);
    } catch (error) {
      logger.error({ error, earning }, 'Failed to create partner earning');
      throw new RepositoryError('Failed to create partner earning', error);
    }
  }

  /**
   * Get partner earnings
   */
  async getEarnings(filters: EarningFilters): Promise<{ data: PartnerEarning[]; total: number }> {
    try {
      const { partnerId, status, page = 1, limit = 10 } = filters;
      const offset = (page - 1) * limit;

      let whereClause = '';
      const params: (string | number)[] = [];
      let paramIndex = 1;

      if (partnerId) {
        whereClause += ` WHERE partner_id = $${paramIndex}`;
        params.push(partnerId);
        paramIndex++;
      }

      if (status) {
        whereClause += whereClause ? ' AND' : ' WHERE';
        whereClause += ` status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM partner_earnings${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM partner_earnings${whereClause}
         ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
      );

      return {
        data: result.rows.map((row) => this.mapToEarning(row)),
        total,
      };
    } catch (error) {
      logger.error({ error, filters }, 'Failed to get partner earnings');
      throw new RepositoryError('Failed to get partner earnings', error);
    }
  }

  /**
   * Update earning status
   */
  async updateEarningStatus(id: string, status: EarningStatus, paidAt?: Date): Promise<PartnerEarning | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE partner_earnings SET status = $1, paid_at = $2 WHERE id = $3 RETURNING *`,
        [status, paidAt || null, id]
      );
      return result.rows[0] ? this.mapToEarning(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, id, status }, 'Failed to update earning status');
      throw new RepositoryError('Failed to update earning status', error);
    }
  }

  /**
   * Create a partner payout
   */
  async createPayout(payout: Omit<PartnerPayout, 'id' | 'createdAt' | 'processedAt'>): Promise<PartnerPayout> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `INSERT INTO partner_payouts (partner_id, amount, method, status, transaction_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [payout.partnerId, payout.amount, payout.method, payout.status, payout.transactionId, payout.notes]
      );
      return this.mapToPayout(result.rows[0]);
    } catch (error) {
      logger.error({ error, payout }, 'Failed to create partner payout');
      throw new RepositoryError('Failed to create partner payout', error);
    }
  }

  /**
   * Get partner payouts
   */
  async getPayouts(filters: PayoutFilters): Promise<{ data: PartnerPayout[]; total: number }> {
    try {
      const { partnerId, status, page = 1, limit = 10 } = filters;
      const offset = (page - 1) * limit;

      let whereClause = '';
      const params: (string | number)[] = [];
      let paramIndex = 1;

      if (partnerId) {
        whereClause += ` WHERE partner_id = $${paramIndex}`;
        params.push(partnerId);
        paramIndex++;
      }

      if (status) {
        whereClause += whereClause ? ' AND' : ' WHERE';
        whereClause += ` status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM partner_payouts${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM partner_payouts${whereClause}
         ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
      );

      return {
        data: result.rows.map((row) => this.mapToPayout(row)),
        total,
      };
    } catch (error) {
      logger.error({ error, filters }, 'Failed to get partner payouts');
      throw new RepositoryError('Failed to get partner payouts', error);
    }
  }

  /**
   * Update payout status
   */
  async updatePayoutStatus(id: string, status: PayoutStatus, transactionId?: string, processedAt?: Date): Promise<PartnerPayout | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE partner_payouts SET status = $1, transaction_id = $2, processed_at = $3 WHERE id = $4 RETURNING *`,
        [status, transactionId || null, processedAt || null, id]
      );
      return result.rows[0] ? this.mapToPayout(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, id, status }, 'Failed to update payout status');
      throw new RepositoryError('Failed to update payout status', error);
    }
  }

  /**
   * Update partner earnings totals
   */
  async updateEarningsTotals(partnerId: string, totalEarnings: number, pendingEarnings: number): Promise<void> {
    try {
      await this.db.query(
        `UPDATE ${this.tableName} SET total_earnings = $1, pending_earnings = $2, updated_at = NOW() WHERE id = $3`,
        [totalEarnings, pendingEarnings, partnerId]
      );
    } catch (error) {
      logger.error({ error, partnerId }, 'Failed to update earnings totals');
      throw new RepositoryError('Failed to update earnings totals', error);
    }
  }

  /**
   * Increment referral count
   */
  async incrementReferralCount(partnerId: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE ${this.tableName} SET referral_count = referral_count + 1, updated_at = NOW() WHERE id = $1`,
        [partnerId]
      );
    } catch (error) {
      logger.error({ error, partnerId }, 'Failed to increment referral count');
      throw new RepositoryError('Failed to increment referral count', error);
    }
  }

  /**
   * Map database row to PartnerEarning entity
   */
  private mapToEarning(row: QueryResultRow): PartnerEarning {
    return {
      id: row.id,
      partnerId: row.partner_id,
      referredUserId: row.referred_user_id,
      subscriptionId: row.subscription_id,
      amount: parseFloat(row.amount),
      commissionRate: parseFloat(row.commission_rate),
      status: row.status as EarningStatus,
      createdAt: row.created_at,
      paidAt: row.paid_at,
    };
  }

  /**
   * Map database row to PartnerPayout entity
   */
  private mapToPayout(row: QueryResultRow): PartnerPayout {
    return {
      id: row.id,
      partnerId: row.partner_id,
      amount: parseFloat(row.amount),
      method: row.method as PayoutMethod,
      status: row.status as PayoutStatus,
      transactionId: row.transaction_id,
      notes: row.notes,
      createdAt: row.created_at,
      processedAt: row.processed_at,
    };
  }
}
