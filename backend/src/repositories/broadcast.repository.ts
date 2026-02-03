import type { QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError, type PaginatedResult } from './base.repository.js';
import type {
  Broadcast,
  CreateBroadcastDTO,
  UpdateBroadcastDTO,
  BroadcastFilters,
  BroadcastButton,
  CreateBroadcastButtonDTO,
  BroadcastAudience,
} from '../entities/broadcast.entity.js';
import { logger } from '../utils/logger.js';

/**
 * Broadcast repository class
 * Handles all database operations for broadcasts and broadcast buttons
 */
export class BroadcastRepository extends BaseRepository<Broadcast, CreateBroadcastDTO, UpdateBroadcastDTO> {
  protected readonly tableName = 'broadcasts';

  /**
   * Map database row to Broadcast entity
   * @param row - Database row
   * @returns Broadcast entity
   */
  protected mapRowToEntity(row: QueryResultRow): Broadcast {
    return {
      id: row.id,
      audience: row.audience,
      planId: row.plan_id,
      content: row.content,
      mediaUrl: row.media_url,
      mediaType: row.media_type,
      status: row.status,
      recipientsCount: row.recipients_count,
      sentCount: row.sent_count,
      failedCount: row.failed_count,
      createdBy: row.created_by,
      createdAt: row.created_at,
      sentAt: row.sent_at,
      errorMessage: row.error_message,
    };
  }

  /**
   * Map database row to BroadcastButton entity
   * @param row - Database row
   * @returns BroadcastButton entity
   */
  private mapButtonRowToEntity(row: QueryResultRow): BroadcastButton {
    return {
      id: row.id,
      broadcastId: row.broadcast_id,
      text: row.text,
      type: row.type,
      value: row.value,
      createdAt: row.created_at,
    };
  }

  /**
   * Get broadcasts with pagination and filters
   * @param page - Page number
   * @param limit - Items per page
   * @param filters - Optional filters
   * @returns Paginated broadcasts
   */
  async getBroadcastsWithPagination(
    page: number,
    limit: number,
    filters?: BroadcastFilters
  ): Promise<PaginatedResult<Broadcast>> {
    try {
      const offset = (page - 1) * limit;
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (filters?.status) {
        conditions.push(`status = $${paramIndex}`);
        params.push(filters.status);
        paramIndex++;
      }

      if (filters?.audience) {
        conditions.push(`audience = $${paramIndex}`);
        params.push(filters.audience);
        paramIndex++;
      }

      if (filters?.createdBy) {
        conditions.push(`created_by = $${paramIndex}`);
        params.push(filters.createdBy);
        paramIndex++;
      }

      if (filters?.startDate) {
        conditions.push(`created_at >= $${paramIndex}`);
        params.push(filters.startDate);
        paramIndex++;
      }

      if (filters?.endDate) {
        conditions.push(`created_at <= $${paramIndex}`);
        params.push(filters.endDate);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM broadcasts ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const dataResult = await this.db.query<QueryResultRow>(
        `SELECT * FROM broadcasts ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset]
      );

      return {
        data: dataResult.rows.map((row) => this.mapRowToEntity(row)),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    } catch (error) {
      logger.error({ error, page, limit, filters }, 'Failed to get broadcasts with pagination');
      throw new RepositoryError('Failed to get broadcasts with pagination', error);
    }
  }

  /**
   * Find broadcast with buttons
   * @param id - Broadcast ID
   * @returns Broadcast with buttons or null
   */
  async findWithButtons(id: string): Promise<{ broadcast: Broadcast; buttons: BroadcastButton[] } | null> {
    try {
      const broadcastResult = await this.db.query<QueryResultRow>(
        'SELECT * FROM broadcasts WHERE id = $1',
        [id]
      );

      if (broadcastResult.rows.length === 0) {
        return null;
      }

      const buttonsResult = await this.db.query<QueryResultRow>(
        'SELECT * FROM broadcast_buttons WHERE broadcast_id = $1 ORDER BY created_at ASC',
        [id]
      );

      return {
        broadcast: this.mapRowToEntity(broadcastResult.rows[0]),
        buttons: buttonsResult.rows.map((row) => this.mapButtonRowToEntity(row)),
      };
    } catch (error) {
      logger.error({ error, id }, 'Failed to find broadcast with buttons');
      throw new RepositoryError('Failed to find broadcast with buttons', error);
    }
  }

  /**
   * Create broadcast button
   * @param data - Button creation data
   * @returns Created button
   */
  async createButton(data: CreateBroadcastButtonDTO): Promise<BroadcastButton> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `INSERT INTO broadcast_buttons (broadcast_id, text, type, value)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [data.broadcastId, data.text, data.type, data.value]
      );
      return this.mapButtonRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, data }, 'Failed to create broadcast button');
      throw new RepositoryError('Failed to create broadcast button', error);
    }
  }

  /**
   * Get buttons for broadcast
   * @param broadcastId - Broadcast ID
   * @returns Array of buttons
   */
  async getButtonsByBroadcastId(broadcastId: string): Promise<BroadcastButton[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM broadcast_buttons WHERE broadcast_id = $1 ORDER BY created_at ASC',
        [broadcastId]
      );
      return result.rows.map((row) => this.mapButtonRowToEntity(row));
    } catch (error) {
      logger.error({ error, broadcastId }, 'Failed to get buttons by broadcast ID');
      throw new RepositoryError('Failed to get buttons by broadcast ID', error);
    }
  }

  /**
   * Delete buttons for broadcast
   * @param broadcastId - Broadcast ID
   */
  async deleteButtonsByBroadcastId(broadcastId: string): Promise<void> {
    try {
      await this.db.query(
        'DELETE FROM broadcast_buttons WHERE broadcast_id = $1',
        [broadcastId]
      );
    } catch (error) {
      logger.error({ error, broadcastId }, 'Failed to delete buttons by broadcast ID');
      throw new RepositoryError('Failed to delete buttons by broadcast ID', error);
    }
  }

  /**
   * Update broadcast status
   * @param id - Broadcast ID
   * @param status - New status
   * @param errorMessage - Optional error message
   * @returns Updated broadcast
   */
  async updateStatus(
    id: string,
    status: Broadcast['status'],
    errorMessage?: string
  ): Promise<Broadcast> {
    try {
      const sentAt = status === 'completed' || status === 'failed' ? 'NOW()' : 'NULL';
      const result = await this.db.query<QueryResultRow>(
        `UPDATE broadcasts 
         SET status = $1, 
             sent_at = ${sentAt},
             error_message = $2
         WHERE id = $3 
         RETURNING *`,
        [status, errorMessage || null, id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Broadcast with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id, status }, 'Failed to update broadcast status');
      throw new RepositoryError('Failed to update broadcast status', error);
    }
  }

  /**
   * Update broadcast statistics
   * @param id - Broadcast ID
   * @param sentCount - Number of successful sends
   * @param failedCount - Number of failed sends
   * @returns Updated broadcast
   */
  async updateStatistics(
    id: string,
    sentCount: number,
    failedCount: number
  ): Promise<Broadcast> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE broadcasts 
         SET sent_count = $1, 
             failed_count = $2
         WHERE id = $3 
         RETURNING *`,
        [sentCount, failedCount, id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Broadcast with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id, sentCount, failedCount }, 'Failed to update broadcast statistics');
      throw new RepositoryError('Failed to update broadcast statistics', error);
    }
  }

  /**
   * Update recipients count
   * @param id - Broadcast ID
   * @param count - Recipients count
   * @returns Updated broadcast
   */
  async updateRecipientsCount(id: string, count: number): Promise<Broadcast> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'UPDATE broadcasts SET recipients_count = $1 WHERE id = $2 RETURNING *',
        [count, id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Broadcast with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id, count }, 'Failed to update recipients count');
      throw new RepositoryError('Failed to update recipients count', error);
    }
  }

  /**
   * Get audience user IDs for broadcast
   * @param audience - Audience type
   * @param planId - Optional plan ID for PLAN audience
   * @returns Array of user IDs
   */
  async getAudienceUserIds(audience: BroadcastAudience, planId?: string): Promise<string[]> {
    try {
      let query: string;
      let params: unknown[] = [];

      switch (audience) {
        case 'ALL':
          query = 'SELECT id FROM users WHERE is_active = true';
          break;
        case 'SUBSCRIBED':
          query = `
            SELECT DISTINCT u.id FROM users u
            INNER JOIN subscriptions s ON u.id = s.user_id
            WHERE u.is_active = true AND s.status = 'active' AND s.end_date > NOW()
          `;
          break;
        case 'UNSUBSCRIBED':
          query = `
            SELECT u.id FROM users u
            WHERE u.is_active = true
            AND NOT EXISTS (
              SELECT 1 FROM subscriptions s 
              WHERE s.user_id = u.id AND s.status = 'active' AND s.end_date > NOW()
            )
          `;
          break;
        case 'EXPIRED':
          query = `
            SELECT DISTINCT u.id FROM users u
            INNER JOIN subscriptions s ON u.id = s.user_id
            WHERE u.is_active = true AND s.status = 'expired'
          `;
          break;
        case 'TRIAL':
          query = `
            SELECT DISTINCT u.id FROM users u
            INNER JOIN subscriptions s ON u.id = s.user_id
            WHERE u.is_active = true AND s.status = 'active' AND s.end_date <= NOW() + INTERVAL '7 days'
          `;
          break;
        case 'PLAN':
          if (!planId) {
            throw new RepositoryError('Plan ID is required for PLAN audience');
          }
          query = `
            SELECT DISTINCT u.id FROM users u
            INNER JOIN subscriptions s ON u.id = s.user_id
            WHERE u.is_active = true AND s.status = 'active' AND s.plan_id = $1
          `;
          params = [planId];
          break;
        default:
          throw new RepositoryError(`Unknown audience type: ${audience}`);
      }

      const result = await this.db.query<{ id: string }>(query, params);
      return result.rows.map((row) => row.id);
    } catch (error) {
      logger.error({ error, audience, planId }, 'Failed to get audience user IDs');
      throw new RepositoryError('Failed to get audience user IDs', error);
    }
  }

  /**
   * Count audience size
   * @param audience - Audience type
   * @param planId - Optional plan ID
   * @returns Count of users in audience
   */
  async countAudience(audience: BroadcastAudience, planId?: string): Promise<number> {
    try {
      const userIds = await this.getAudienceUserIds(audience, planId);
      return userIds.length;
    } catch (error) {
      logger.error({ error, audience, planId }, 'Failed to count audience');
      throw new RepositoryError('Failed to count audience', error);
    }
  }
}
