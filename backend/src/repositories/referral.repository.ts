/**
 * Referral Repository
 *
 * Repositories for managing referral system data including
 * referral rules, referrals, and referral rewards.
 */

import type { Pool, QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError } from './base.repository.js';
import type {
  ReferralRule,
  Referral,
  ReferralReward,
  ReferralStatistics,
  CreateReferralRuleDto,
  UpdateReferralRuleDto,
  CreateReferralDto,
  UpdateReferralDto,
  CreateReferralRewardDto,
  UpdateReferralRewardDto,
} from '../entities/referral.entity.js';

/**
 * Referral Rule Repository
 */
export class ReferralRuleRepository extends BaseRepository<ReferralRule, CreateReferralRuleDto, UpdateReferralRuleDto> {
  protected readonly tableName = 'referral_rules';

  constructor(db: Pool) {
    super(db);
  }

  /**
   * Map database row to ReferralRule entity
   */
  protected mapRowToEntity(row: QueryResultRow): ReferralRule {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      type: row.type as ReferralRule['type'],
      referrerReward: parseFloat(row.referrer_reward as string) || 0,
      referredReward: parseFloat(row.referred_reward as string) || 0,
      minPurchaseAmount: row.min_purchase_amount ? parseFloat(row.min_purchase_amount as string) : undefined,
      appliesToPlans: (row.applies_to_plans as string[]) || undefined,
      isActive: row.is_active as boolean,
      startDate: row.start_date ? new Date(row.start_date as string) : undefined,
      endDate: row.end_date ? new Date(row.end_date as string) : undefined,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  /**
   * Find active rules
   */
  async findActive(): Promise<ReferralRule[]> {
    try {
      const result = await this.db.query<QueryResultRow>(`
        SELECT * FROM ${this.tableName}
        WHERE is_active = true
          AND (start_date IS NULL OR start_date <= NOW())
          AND (end_date IS NULL OR end_date >= NOW())
        ORDER BY created_at ASC
      `);
      return result.rows.map(row => this.mapRowToEntity(row));
    } catch (error) {
      throw new RepositoryError('Failed to find active referral rules', error);
    }
  }

  /**
   * Find rules by type
   */
  async findByType(type: string): Promise<ReferralRule[]> {
    try {
      const result = await this.db.query<QueryResultRow>(`
        SELECT * FROM ${this.tableName}
        WHERE type = $1
          AND is_active = true
        ORDER BY created_at ASC
      `, [type]);
      return result.rows.map(row => this.mapRowToEntity(row));
    } catch (error) {
      throw new RepositoryError('Failed to find referral rules by type', error);
    }
  }
}

/**
 * Referral Filters Type
 */
interface ReferralFilters {
  status?: string;
  referrerId?: string;
  referredId?: string;
  ruleId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

/**
 * Referral Repository
 */
export class ReferralRepository extends BaseRepository<Referral, CreateReferralDto, UpdateReferralDto> {
  protected readonly tableName = 'referrals';

  constructor(db: Pool) {
    super(db);
  }

  /**
   * Map database row to Referral entity
   */
  protected mapRowToEntity(row: QueryResultRow): Referral {
    return {
      id: row.id as string,
      referrerId: row.referrer_id as string,
      referredId: row.referred_id as string,
      referralCode: row.referral_code as string,
      status: row.status as Referral['status'],
      referrerReward: parseFloat(row.referrer_reward as string) || 0,
      referredReward: parseFloat(row.referred_reward as string) || 0,
      ruleId: row.rule_id as string,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
      cancelledAt: row.cancelled_at ? new Date(row.cancelled_at as string) : undefined,
      cancelledReason: row.cancelled_reason as string,
      notes: row.notes as string,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  /**
   * Find referrals by referrer
   */
  async findByReferrer(referrerId: string, filters?: ReferralFilters): Promise<Referral[]> {
    try {
      let query = `SELECT * FROM ${this.tableName} WHERE referrer_id = $1`;
      const params: (string | number | Date)[] = [referrerId];
      let paramIndex = 1;

      if (filters?.status) {
        query += ` AND status = $${++paramIndex}`;
        params.push(filters.status);
      }

      query += ` ORDER BY created_at DESC`;
      const result = await this.db.query<QueryResultRow>(query, params);
      return result.rows.map(row => this.mapRowToEntity(row));
    } catch (error) {
      throw new RepositoryError('Failed to find referrals by referrer', error);
    }
  }

  /**
   * Find referrals by referred user
   */
  async findByReferred(referredId: string): Promise<Referral[]> {
    try {
      const query = `SELECT * FROM ${this.tableName} WHERE referred_id = $1 ORDER BY created_at DESC`;
      const result = await this.db.query<QueryResultRow>(query, [referredId]);
      return result.rows.map(row => this.mapRowToEntity(row));
    } catch (error) {
      throw new RepositoryError('Failed to find referrals by referred user', error);
    }
  }

  /**
   * Find by referral code
   */
  async findByReferralCode(code: string): Promise<Referral | null> {
    try {
      const query = `SELECT * FROM ${this.tableName} WHERE referral_code = $1 LIMIT 1`;
      const result = await this.db.query<QueryResultRow>(query, [code]);
      return result.rows.length ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      throw new RepositoryError('Failed to find referral by code', error);
    }
  }

  /**
   * Check if referral exists between users
   */
  async existsReferral(referrerId: string, referredId: string): Promise<boolean> {
    try {
      const query = `SELECT 1 FROM ${this.tableName} WHERE referrer_id = $1 AND referred_id = $2 LIMIT 1`;
      const result = await this.db.query<QueryResultRow>(query, [referrerId, referredId]);
      return result.rows.length > 0;
    } catch (error) {
      throw new RepositoryError('Failed to check referral exists', error);
    }
  }

  /**
   * Count referrals by referrer
   */
  async countByReferrer(referrerId: string, status?: string): Promise<number> {
    try {
      let query = `SELECT COUNT(*) FROM ${this.tableName} WHERE referrer_id = $1`;
      const params: (string | number)[] = [referrerId];

      if (status) {
        query += ` AND status = $2`;
        params.push(status);
      }

      const result = await this.db.query<{ count: string }>(query, params);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      throw new RepositoryError('Failed to count referrals by referrer', error);
    }
  }

  /**
   * Search referrals
   */
  async search(filters: ReferralFilters): Promise<{ data: Referral[]; total: number }> {
    try {
      let query = `SELECT * FROM ${this.tableName}`;
      let countQuery = `SELECT COUNT(*) FROM ${this.tableName}`;
      const conditions: string[] = [];
      const params: (string | number | Date)[] = [];
      let paramIndex = 0;

      if (filters.status) {
        conditions.push(`status = $${++paramIndex}`);
        params.push(filters.status);
      }

      if (filters.referrerId) {
        conditions.push(`referrer_id = $${++paramIndex}`);
        params.push(filters.referrerId);
      }

      if (filters.referredId) {
        conditions.push(`referred_id = $${++paramIndex}`);
        params.push(filters.referredId);
      }

      if (filters.ruleId) {
        conditions.push(`rule_id = $${++paramIndex}`);
        params.push(filters.ruleId);
      }

      if (filters.dateFrom) {
        conditions.push(`created_at >= $${++paramIndex}`);
        params.push(filters.dateFrom);
      }

      if (filters.dateTo) {
        conditions.push(`created_at <= $${++paramIndex}`);
        params.push(filters.dateTo);
      }

      if (conditions.length > 0) {
        const whereClause = ` WHERE ${conditions.join(' AND ')}`;
        query += whereClause;
        countQuery += whereClause;
      }

      // Add sorting
      const sortBy = filters.sortBy || 'created_at';
      const sortOrder = filters.sortOrder || 'desc';
      query += ` ORDER BY ${sortBy} ${sortOrder.toUpperCase()}`;

      // Add pagination
      const page = filters.page || 1;
      const limit = filters.limit || 20;
      const offset = (page - 1) * limit;
      query += ` LIMIT $${++paramIndex} OFFSET $${++paramIndex}`;
      params.push(limit, offset);

      const [dataResult, countResult] = await Promise.all([
        this.db.query<QueryResultRow>(query, params),
        this.db.query<{ count: string }>(countQuery, params.slice(0, -2)),
      ]);

      return {
        data: dataResult.rows.map(row => this.mapRowToEntity(row)),
        total: parseInt(countResult.rows[0].count, 10),
      };
    } catch (error) {
      throw new RepositoryError('Failed to search referrals', error);
    }
  }
}

/**
 * Referral Reward Filters Type
 */
interface ReferralRewardFilters {
  status?: string;
  userId?: string;
  referralId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

/**
 * Referral Reward Repository
 */
export class ReferralRewardRepository extends BaseRepository<ReferralReward, CreateReferralRewardDto, UpdateReferralRewardDto> {
  protected readonly tableName = 'referral_rewards';

  constructor(db: Pool) {
    super(db);
  }

  /**
   * Map database row to ReferralReward entity
   */
  protected mapRowToEntity(row: QueryResultRow): ReferralReward {
    return {
      id: row.id as string,
      referralId: row.referral_id as string,
      userId: row.user_id as string,
      amount: parseFloat(row.amount as string) || 0,
      status: row.status as ReferralReward['status'],
      ruleId: row.rule_id as string,
      description: row.description as string,
      paidAt: row.paid_at ? new Date(row.paid_at as string) : undefined,
      paidBy: row.paid_by as string,
      paidMethod: row.paid_method as string,
      transactionId: row.transaction_id as string,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  /**
   * Find rewards by referral
   */
  async findByReferral(referralId: string): Promise<ReferralReward[]> {
    try {
      const query = `SELECT * FROM ${this.tableName} WHERE referral_id = $1 ORDER BY created_at DESC`;
      const result = await this.db.query<QueryResultRow>(query, [referralId]);
      return result.rows.map(row => this.mapRowToEntity(row));
    } catch (error) {
      throw new RepositoryError('Failed to find rewards by referral', error);
    }
  }

  /**
   * Find rewards by user
   */
  async findByUser(userId: string, status?: string): Promise<ReferralReward[]> {
    try {
      let query = `SELECT * FROM ${this.tableName} WHERE user_id = $1`;
      const params: (string | number)[] = [userId];

      if (status) {
        query += ` AND status = $2`;
        params.push(status);
      }

      query += ` ORDER BY created_at DESC`;
      const result = await this.db.query<QueryResultRow>(query, params);
      return result.rows.map(row => this.mapRowToEntity(row));
    } catch (error) {
      throw new RepositoryError('Failed to find rewards by user', error);
    }
  }

  /**
   * Get total rewards by user
   */
  async getTotalByUser(userId: string, status?: string): Promise<number> {
    try {
      let query = `SELECT COALESCE(SUM(amount), 0) as total FROM ${this.tableName} WHERE user_id = $1`;
      const params: (string | number)[] = [userId];

      if (status) {
        query += ` AND status = $2`;
        params.push(status);
      }

      const result = await this.db.query<{ total: string }>(query, params);
      return parseFloat(result.rows[0].total);
    } catch (error) {
      throw new RepositoryError('Failed to get total rewards by user', error);
    }
  }

  /**
   * Search rewards
   */
  async search(filters: ReferralRewardFilters): Promise<{ data: ReferralReward[]; total: number }> {
    try {
      let query = `SELECT * FROM ${this.tableName}`;
      let countQuery = `SELECT COUNT(*) FROM ${this.tableName}`;
      const conditions: string[] = [];
      const params: (string | number | Date)[] = [];
      let paramIndex = 0;

      if (filters.status) {
        conditions.push(`status = $${++paramIndex}`);
        params.push(filters.status);
      }

      if (filters.userId) {
        conditions.push(`user_id = $${++paramIndex}`);
        params.push(filters.userId);
      }

      if (filters.referralId) {
        conditions.push(`referral_id = $${++paramIndex}`);
        params.push(filters.referralId);
      }

      if (filters.dateFrom) {
        conditions.push(`created_at >= $${++paramIndex}`);
        params.push(filters.dateFrom);
      }

      if (filters.dateTo) {
        conditions.push(`created_at <= $${++paramIndex}`);
        params.push(filters.dateTo);
      }

      if (conditions.length > 0) {
        const whereClause = ` WHERE ${conditions.join(' AND ')}`;
        query += whereClause;
        countQuery += whereClause;
      }

      // Add sorting
      const sortBy = filters.sortBy || 'created_at';
      const sortOrder = filters.sortOrder || 'desc';
      query += ` ORDER BY ${sortBy} ${sortOrder.toUpperCase()}`;

      // Add pagination
      const page = filters.page || 1;
      const limit = filters.limit || 20;
      const offset = (page - 1) * limit;
      query += ` LIMIT $${++paramIndex} OFFSET $${++paramIndex}`;
      params.push(limit, offset);

      const [dataResult, countResult] = await Promise.all([
        this.db.query<QueryResultRow>(query, params),
        this.db.query<{ count: string }>(countQuery, params.slice(0, -2)),
      ]);

      return {
        data: dataResult.rows.map(row => this.mapRowToEntity(row)),
        total: parseInt(countResult.rows[0].count, 10),
      };
    } catch (error) {
      throw new RepositoryError('Failed to search rewards', error);
    }
  }

  /**
   * Get referral statistics
   */
  async getStatistics(): Promise<ReferralStatistics> {
    try {
      const totalResult = await this.db.query<{ count: string }>(`SELECT COUNT(*) FROM referrals`);
      const activeResult = await this.db.query<{ count: string }>(`SELECT COUNT(*) FROM referrals WHERE status = 'active'`);
      const completedResult = await this.db.query<{ count: string }>(`SELECT COUNT(*) FROM referrals WHERE status = 'completed'`);
      const paidRewardsResult = await this.db.query<{ sum: string }>(`SELECT COALESCE(SUM(amount), 0) as sum FROM ${this.tableName} WHERE status = 'paid'`);
      const pendingRewardsResult = await this.db.query<{ sum: string }>(`SELECT COALESCE(SUM(amount), 0) as sum FROM ${this.tableName} WHERE status = 'pending'`);

      const topReferrersResult = await this.db.query<{
        user_id: string;
        referral_count: string;
        total_rewards: string;
      }>(`
        SELECT
          r.referrer_id as user_id,
          COUNT(r.id) as referral_count,
          COALESCE(SUM(rr.amount), 0) as total_rewards
        FROM referrals r
        LEFT JOIN ${this.tableName} rr ON r.id = rr.referral_id AND rr.user_id = r.referrer_id
        WHERE r.status = 'completed'
        GROUP BY r.referrer_id
        ORDER BY referral_count DESC
        LIMIT 10
      `);

      return {
        totalReferrals: parseInt(totalResult.rows[0].count, 10),
        activeReferrals: parseInt(activeResult.rows[0].count, 10),
        completedReferrals: parseInt(completedResult.rows[0].count, 10),
        totalRewardsPaid: parseFloat(paidRewardsResult.rows[0].sum),
        pendingRewards: parseFloat(pendingRewardsResult.rows[0].sum),
        topReferrers: topReferrersResult.rows.map(row => ({
          userId: row.user_id,
          referralCount: parseInt(row.referral_count, 10),
          totalRewards: parseFloat(row.total_rewards),
        })),
      };
    } catch (error) {
      throw new RepositoryError('Failed to get referral statistics', error);
    }
  }
}
