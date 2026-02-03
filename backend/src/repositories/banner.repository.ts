import type { QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError } from './base.repository.js';
import type {
  Banner,
  CreateBannerDTO,
  UpdateBannerDTO,
  BannerFilters,
  BannerPosition,
} from '../entities/banner.entity.js';
import { logger } from '../utils/logger.js';

/**
 * Banner repository class
 * Handles all database operations for banners
 */
export class BannerRepository extends BaseRepository<Banner, CreateBannerDTO, UpdateBannerDTO> {
  protected readonly tableName = 'banners';

  /**
   * Map database row to Banner entity
   * @param row - Database row
   * @returns Banner entity
   */
  protected mapRowToEntity(row: QueryResultRow): Banner {
    return {
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      imageUrl: row.image_url,
      linkUrl: row.link_url,
      position: row.position,
      displayOrder: row.display_order,
      isActive: row.is_active,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      clickCount: row.click_count,
      impressionCount: row.impression_count,
      backgroundColor: row.background_color,
      textColor: row.text_color,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find active banners by position
   * Handles scheduling (starts_at, ends_at)
   * @param position - Banner position
   * @returns Array of active banners for the position
   */
  async findActiveByPosition(position: BannerPosition): Promise<Banner[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM banners 
         WHERE position = $1 
           AND is_active = true
           AND (starts_at IS NULL OR starts_at <= NOW())
           AND (ends_at IS NULL OR ends_at >= NOW())
         ORDER BY display_order ASC, created_at DESC`,
        [position]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, position }, 'Failed to find active banners by position');
      throw new RepositoryError('Failed to find active banners by position', error);
    }
  }

  /**
   * Find all active banners
   * Handles scheduling (starts_at, ends_at)
   * @returns Array of active banners
   */
  async findActive(): Promise<Banner[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM banners 
         WHERE is_active = true
           AND (starts_at IS NULL OR starts_at <= NOW())
           AND (ends_at IS NULL OR ends_at >= NOW())
         ORDER BY position ASC, display_order ASC, created_at DESC`
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error }, 'Failed to find active banners');
      throw new RepositoryError('Failed to find active banners', error);
    }
  }

  /**
   * Increment click count for a banner
   * @param id - Banner ID
   * @returns Updated banner
   */
  async incrementClicks(id: string): Promise<Banner> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE banners 
         SET click_count = click_count + 1 
         WHERE id = $1 
         RETURNING *`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Banner with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id }, 'Failed to increment banner clicks');
      throw new RepositoryError('Failed to increment banner clicks', error);
    }
  }

  /**
   * Increment impression count for a banner
   * @param id - Banner ID
   * @returns Updated banner
   */
  async incrementImpressions(id: string): Promise<Banner> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE banners 
         SET impression_count = impression_count + 1 
         WHERE id = $1 
         RETURNING *`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Banner with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id }, 'Failed to increment banner impressions');
      throw new RepositoryError('Failed to increment banner impressions', error);
    }
  }

  /**
   * Get banners with pagination and filters
   * @param page - Page number
   * @param limit - Items per page
   * @param filters - Optional filters
   * @returns Paginated banners
   */
  async getBannersWithPagination(
    page: number,
    limit: number,
    filters?: BannerFilters
  ): Promise<{
    data: Banner[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    try {
      const offset = (page - 1) * limit;
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (filters?.position) {
        conditions.push(`position = $${paramIndex}`);
        params.push(filters.position);
        paramIndex++;
      }

      if (filters?.isActive !== undefined) {
        conditions.push(`is_active = $${paramIndex}`);
        params.push(filters.isActive);
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
        `SELECT COUNT(*) FROM banners ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const dataResult = await this.db.query<QueryResultRow>(
        `SELECT * FROM banners ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
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
      logger.error({ error, page, limit, filters }, 'Failed to get banners with pagination');
      throw new RepositoryError('Failed to get banners with pagination', error);
    }
  }
}
