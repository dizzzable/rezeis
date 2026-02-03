import type { Pool, QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError } from './base.repository.js';
import type {
  Notification,
  CreateNotificationDto,
  UpdateNotificationDto,
  NotificationFilters,
} from '../entities/notification.entity.js';
import { logger } from '../utils/logger.js';

/**
 * Repository for notification operations
 */
export class NotificationRepository extends BaseRepository<
  Notification,
  CreateNotificationDto,
  UpdateNotificationDto
> {
  protected readonly tableName = 'notifications';

  constructor(db: Pool) {
    super(db);
  }

  /**
   * Map database row to Notification entity
   */
  protected mapRowToEntity(row: QueryResultRow): Notification {
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type as Notification['type'],
      title: row.title,
      message: row.message,
      isRead: row.is_read,
      linkUrl: row.link_url,
      metadata: row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find notifications with filters
   */
  async findWithFilters(
    filters: NotificationFilters,
    page = 1,
    limit = 25,
    sortBy: 'created_at' | 'updated_at' = 'created_at',
    sortOrder: 'asc' | 'desc' = 'desc'
  ): Promise<{ data: Notification[]; total: number }> {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (filters.userId) {
        conditions.push(`user_id = $${paramIndex}`);
        params.push(filters.userId);
        paramIndex++;
      }

      if (filters.type) {
        conditions.push(`type = $${paramIndex}`);
        params.push(filters.type);
        paramIndex++;
      }

      if (filters.isRead !== undefined) {
        conditions.push(`is_read = $${paramIndex}`);
        params.push(filters.isRead);
        paramIndex++;
      }

      if (filters.search) {
        conditions.push(`(title ILIKE $${paramIndex} OR message ILIKE $${paramIndex})`);
        params.push(`%${filters.search}%`);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM ${this.tableName} ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      // Get paginated results
      const offset = (page - 1) * limit;
      const query = `
        SELECT * FROM ${this.tableName}
        ${whereClause}
        ORDER BY ${sortBy} ${sortOrder.toUpperCase()}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      const result = await this.db.query<QueryResultRow>(query, [...params, limit, offset]);

      return {
        data: result.rows.map((row) => this.mapRowToEntity(row)),
        total,
      };
    } catch (error) {
      logger.error({ error, filters }, 'Failed to find notifications with filters');
      throw new RepositoryError('Failed to find notifications with filters', error);
    }
  }

  /**
   * Find notifications by user ID
   */
  async findByUserId(
    userId: string,
    page = 1,
    limit = 25
  ): Promise<{ data: Notification[]; total: number }> {
    return this.findWithFilters({ userId }, page, limit);
  }

  /**
   * Find unread notifications by user ID
   */
  async findUnreadByUserId(
    userId: string,
    page = 1,
    limit = 25
  ): Promise<{ data: Notification[]; total: number }> {
    return this.findWithFilters({ userId, isRead: false }, page, limit);
  }

  /**
   * Count notifications
   */
  async count(filters: NotificationFilters = {}): Promise<number> {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (filters.userId) {
        conditions.push(`user_id = $${paramIndex}`);
        params.push(filters.userId);
        paramIndex++;
      }

      if (filters.type) {
        conditions.push(`type = $${paramIndex}`);
        params.push(filters.type);
        paramIndex++;
      }

      if (filters.isRead !== undefined) {
        conditions.push(`is_read = $${paramIndex}`);
        params.push(filters.isRead);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const query = `SELECT COUNT(*) FROM ${this.tableName} ${whereClause}`;

      const result = await this.db.query<{ count: string }>(query, params);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ error, filters }, 'Failed to count notifications');
      throw new RepositoryError('Failed to count notifications', error);
    }
  }

  /**
   * Count unread notifications for a user
   */
  async countUnreadByUserId(userId: string): Promise<number> {
    return this.count({ userId, isRead: false });
  }

  /**
   * Mark notifications as read
   */
  async markAsRead(ids: string[], userId?: string): Promise<number> {
    try {
      if (ids.length === 0) return 0;

      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      const params: unknown[] = [...ids];

      let query = `
        UPDATE ${this.tableName}
        SET is_read = true, updated_at = NOW()
        WHERE id IN (${placeholders}) AND is_read = false
      `;

      if (userId) {
        query += ` AND user_id = $${ids.length + 1}`;
        params.push(userId);
      }

      const result = await this.db.query<QueryResultRow>(query, params);
      return result.rowCount || 0;
    } catch (error) {
      logger.error({ error, ids, userId }, 'Failed to mark notifications as read');
      throw new RepositoryError('Failed to mark notifications as read', error);
    }
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<number> {
    try {
      const query = `
        UPDATE ${this.tableName}
        SET is_read = true, updated_at = NOW()
        WHERE user_id = $1 AND is_read = false
      `;

      const result = await this.db.query<QueryResultRow>(query, [userId]);
      return result.rowCount || 0;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to mark all notifications as read');
      throw new RepositoryError('Failed to mark all notifications as read', error);
    }
  }

  /**
   * Get notification statistics
   */
  async getStatistics(): Promise<{
    total: number;
    unread: number;
    read: number;
    byType: Record<string, number>;
  }> {
    try {
      const totalQuery = `SELECT COUNT(*) FROM ${this.tableName}`;
      const unreadQuery = `SELECT COUNT(*) FROM ${this.tableName} WHERE is_read = false`;
      const readQuery = `SELECT COUNT(*) FROM ${this.tableName} WHERE is_read = true`;
      const byTypeQuery = `
        SELECT type, COUNT(*) as count
        FROM ${this.tableName}
        GROUP BY type
      `;

      const [totalResult, unreadResult, readResult, byTypeResult] = await Promise.all([
        this.db.query<{ count: string }>(totalQuery),
        this.db.query<{ count: string }>(unreadQuery),
        this.db.query<{ count: string }>(readQuery),
        this.db.query<{ type: string; count: string }>(byTypeQuery),
      ]);

      const byType: Record<string, number> = {};
      byTypeResult.rows.forEach((row) => {
        byType[row.type] = parseInt(row.count, 10);
      });

      return {
        total: parseInt(totalResult.rows[0].count, 10),
        unread: parseInt(unreadResult.rows[0].count, 10),
        read: parseInt(readResult.rows[0].count, 10),
        byType,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get notification statistics');
      throw new RepositoryError('Failed to get notification statistics', error);
    }
  }

  /**
   * Get user notification statistics
   */
  async getUserStatistics(userId: string): Promise<{
    total: number;
    unread: number;
    read: number;
    byType: Record<string, number>;
  }> {
    try {
      const baseQuery = `SELECT COUNT(*) FROM ${this.tableName} WHERE user_id = $1`;
      const unreadQuery = `${baseQuery} AND is_read = false`;
      const readQuery = `${baseQuery} AND is_read = true`;
      const byTypeQuery = `
        SELECT type, COUNT(*) as count
        FROM ${this.tableName}
        WHERE user_id = $1
        GROUP BY type
      `;

      const [totalResult, unreadResult, readResult, byTypeResult] = await Promise.all([
        this.db.query<{ count: string }>(baseQuery, [userId]),
        this.db.query<{ count: string }>(unreadQuery, [userId]),
        this.db.query<{ count: string }>(readQuery, [userId]),
        this.db.query<{ type: string; count: string }>(byTypeQuery, [userId]),
      ]);

      const byType: Record<string, number> = {};
      byTypeResult.rows.forEach((row) => {
        byType[row.type] = parseInt(row.count, 10);
      });

      return {
        total: parseInt(totalResult.rows[0].count, 10),
        unread: parseInt(unreadResult.rows[0].count, 10),
        read: parseInt(readResult.rows[0].count, 10),
        byType,
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get user notification statistics');
      throw new RepositoryError('Failed to get user notification statistics', error);
    }
  }

  /**
   * Delete old read notifications
   */
  async deleteOldReadNotifications(days: number): Promise<number> {
    try {
      const query = `
        DELETE FROM ${this.tableName}
        WHERE is_read = true AND created_at < NOW() - INTERVAL '${days} days'
      `;

      const result = await this.db.query<QueryResultRow>(query);
      return result.rowCount || 0;
    } catch (error) {
      logger.error({ error, days }, 'Failed to delete old read notifications');
      throw new RepositoryError('Failed to delete old read notifications', error);
    }
  }
}
