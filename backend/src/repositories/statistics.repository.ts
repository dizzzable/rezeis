import type { Pool, QueryResultRow } from 'pg';
import { RepositoryError } from './base.repository.js';
import type { DailyStatistics } from '../entities/statistics.entity.js';
import { logger } from '../utils/logger.js';

/**
 * Statistics repository class
 * Handles all database operations for daily statistics
 */
export class StatisticsRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Map database row to DailyStatistics entity
   * @param row - Database row
   * @returns DailyStatistics entity
   */
  private mapRowToEntity(row: QueryResultRow): DailyStatistics {
    return {
      id: row.id,
      date: row.date,
      newUsers: row.new_users,
      activeUsers: row.active_users,
      newSubscriptions: row.new_subscriptions,
      revenue: row.revenue,
      createdAt: row.created_at,
    };
  }

  /**
   * Get daily statistics for a specific date
   * @param date - Date to get statistics for
   * @returns Daily statistics or null
   */
  async getDailyStats(date: Date): Promise<DailyStatistics | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM daily_statistics WHERE date = $1',
        [date]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, date }, 'Failed to get daily statistics');
      throw new RepositoryError('Failed to get daily statistics', error);
    }
  }

  /**
   * Get statistics by date range
   * @param startDate - Start date
   * @param endDate - End date
   * @returns Array of daily statistics
   */
  async getStatsByPeriod(startDate: Date, endDate: Date): Promise<DailyStatistics[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM daily_statistics WHERE date BETWEEN $1 AND $2 ORDER BY date ASC',
        [startDate, endDate]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, startDate, endDate }, 'Failed to get statistics by period');
      throw new RepositoryError('Failed to get statistics by period', error);
    }
  }

  /**
   * Upsert daily statistics
   * @param stats - Statistics data
   * @returns Created or updated statistics
   */
  async upsertDailyStats(stats: Partial<DailyStatistics>): Promise<DailyStatistics> {
    try {
      const date = stats.date || new Date();
      const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());

      const existing = await this.getDailyStats(dateOnly);

      if (existing) {
        const updates: string[] = [];
        const values: unknown[] = [];
        let paramIndex = 1;

        if (stats.newUsers !== undefined) {
          updates.push(`new_users = $${paramIndex}`);
          values.push(stats.newUsers);
          paramIndex++;
        }

        if (stats.activeUsers !== undefined) {
          updates.push(`active_users = $${paramIndex}`);
          values.push(stats.activeUsers);
          paramIndex++;
        }

        if (stats.newSubscriptions !== undefined) {
          updates.push(`new_subscriptions = $${paramIndex}`);
          values.push(stats.newSubscriptions);
          paramIndex++;
        }

        if (stats.revenue !== undefined) {
          updates.push(`revenue = $${paramIndex}`);
          values.push(stats.revenue);
          paramIndex++;
        }

        if (updates.length === 0) {
          return existing;
        }

        const result = await this.db.query<QueryResultRow>(
          `UPDATE daily_statistics 
           SET ${updates.join(', ')}
           WHERE id = $${paramIndex}
           RETURNING *`,
          [...values, existing.id]
        );

        return this.mapRowToEntity(result.rows[0]);
      }

      const result = await this.db.query<QueryResultRow>(
        `INSERT INTO daily_statistics (date, new_users, active_users, new_subscriptions, revenue)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          dateOnly,
          stats.newUsers || 0,
          stats.activeUsers || 0,
          stats.newSubscriptions || 0,
          stats.revenue || 0,
        ]
      );

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, stats }, 'Failed to upsert daily statistics');
      throw new RepositoryError('Failed to upsert daily statistics', error);
    }
  }

  /**
   * Get total revenue
   * @returns Total revenue
   */
  async getTotalRevenue(): Promise<number> {
    try {
      const result = await this.db.query<{ total: string }>(
        'SELECT COALESCE(SUM(revenue), 0) as total FROM daily_statistics'
      );
      return parseFloat(result.rows[0].total);
    } catch (error) {
      logger.error({ error }, 'Failed to get total revenue');
      throw new RepositoryError('Failed to get total revenue', error);
    }
  }

  /**
   * Get new users count for the last N days
   * @param days - Number of days
   * @returns Count of new users
   */
  async getNewUsersCount(days: number): Promise<number> {
    try {
      const result = await this.db.query<{ count: string }>(
        `SELECT COALESCE(SUM(new_users), 0) as count 
         FROM daily_statistics 
         WHERE date >= CURRENT_DATE - INTERVAL '${days} days'`
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ error, days }, 'Failed to get new users count');
      throw new RepositoryError('Failed to get new users count', error);
    }
  }

  /**
   * Increment new users count for today
   * @param count - Number to increment (default 1)
   */
  async incrementNewUsers(count = 1): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      await this.db.query(
        `INSERT INTO daily_statistics (date, new_users, active_users, new_subscriptions, revenue)
         VALUES ($1, $2, 0, 0, 0)
         ON CONFLICT (date) DO UPDATE SET new_users = daily_statistics.new_users + $2`,
        [today, count]
      );
    } catch (error) {
      logger.error({ error, count }, 'Failed to increment new users');
      throw new RepositoryError('Failed to increment new users', error);
    }
  }

  /**
   * Increment new subscriptions count for today
   * @param count - Number to increment (default 1)
   */
  async incrementNewSubscriptions(count = 1): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      await this.db.query(
        `INSERT INTO daily_statistics (date, new_users, active_users, new_subscriptions, revenue)
         VALUES ($1, 0, 0, $2, 0)
         ON CONFLICT (date) DO UPDATE SET new_subscriptions = daily_statistics.new_subscriptions + $2`,
        [today, count]
      );
    } catch (error) {
      logger.error({ error, count }, 'Failed to increment new subscriptions');
      throw new RepositoryError('Failed to increment new subscriptions', error);
    }
  }

  /**
   * Add revenue for today
   * @param amount - Amount to add
   */
  async addRevenue(amount: number): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      await this.db.query(
        `INSERT INTO daily_statistics (date, new_users, active_users, new_subscriptions, revenue)
         VALUES ($1, 0, 0, 0, $2)
         ON CONFLICT (date) DO UPDATE SET revenue = daily_statistics.revenue + $2`,
        [today, amount]
      );
    } catch (error) {
      logger.error({ error, amount }, 'Failed to add revenue');
      throw new RepositoryError('Failed to add revenue', error);
    }
  }

  /**
   * Get statistics summary for dashboard
   * @returns Summary statistics
   */
  async getDashboardSummary(): Promise<{
    totalRevenue: number;
    newUsersToday: number;
    newSubscriptionsToday: number;
    activeUsersToday: number;
  }> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const result = await this.db.query<{
        total_revenue: string;
        new_users_today: string;
        new_subscriptions_today: string;
        active_users_today: string;
      }>(
        `SELECT 
           COALESCE(SUM(revenue), 0) as total_revenue,
           COALESCE(SUM(CASE WHEN date = $1 THEN new_users END), 0) as new_users_today,
           COALESCE(SUM(CASE WHEN date = $1 THEN new_subscriptions END), 0) as new_subscriptions_today,
           COALESCE(SUM(CASE WHEN date = $1 THEN active_users END), 0) as active_users_today
         FROM daily_statistics`,
        [today]
      );

      return {
        totalRevenue: parseFloat(result.rows[0].total_revenue),
        newUsersToday: parseInt(result.rows[0].new_users_today, 10),
        newSubscriptionsToday: parseInt(result.rows[0].new_subscriptions_today, 10),
        activeUsersToday: parseInt(result.rows[0].active_users_today, 10),
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get dashboard summary');
      throw new RepositoryError('Failed to get dashboard summary', error);
    }
  }
}
