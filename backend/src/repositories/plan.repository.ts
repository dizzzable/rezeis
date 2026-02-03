import type { QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError } from './base.repository.js';
import type { Plan, CreatePlanDTO, UpdatePlanDTO } from '../entities/plan.entity.js';
import { logger } from '../utils/logger.js';

/**
 * Plan repository class
 * Handles all database operations for plans
 */
export class PlanRepository extends BaseRepository<Plan, CreatePlanDTO, UpdatePlanDTO> {
  protected readonly tableName = 'plans';

  /**
   * Map database row to Plan entity
   * @param row - Database row
   * @returns Plan entity
   */
  protected mapRowToEntity(row: QueryResultRow): Plan {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      price: row.price,
      durationDays: row.duration_days,
      trafficLimit: row.traffic_limit,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find all active plans
   * @returns Array of active plans
   */
  async findActive(): Promise<Plan[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM plans WHERE is_active = true ORDER BY price ASC'
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error }, 'Failed to find active plans');
      throw new RepositoryError('Failed to find active plans', error);
    }
  }

  /**
   * Find plans by price range
   * @param min - Minimum price
   * @param max - Maximum price
   * @returns Array of plans in price range
   */
  async findByPriceRange(min: number, max: number): Promise<Plan[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM plans WHERE price BETWEEN $1 AND $2 ORDER BY price ASC',
        [min, max]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, min, max }, 'Failed to find plans by price range');
      throw new RepositoryError('Failed to find plans by price range', error);
    }
  }

  /**
   * Find plan by name
   * @param name - Plan name
   * @returns Plan or null if not found
   */
  async findByName(name: string): Promise<Plan | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM plans WHERE name = $1',
        [name]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, name }, 'Failed to find plan by name');
      throw new RepositoryError('Failed to find plan by name', error);
    }
  }

  /**
   * Toggle plan active status
   * @param id - Plan ID
   * @returns Updated plan
   */
  async toggleActive(id: string): Promise<Plan> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE plans 
         SET is_active = NOT is_active, updated_at = NOW() 
         WHERE id = $1 
         RETURNING *`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Plan with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id }, 'Failed to toggle plan active status');
      throw new RepositoryError('Failed to toggle plan active status', error);
    }
  }

  /**
   * Find plans by duration
   * @param durationDays - Duration in days
   * @returns Array of plans with matching duration
   */
  async findByDuration(durationDays: number): Promise<Plan[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM plans WHERE duration_days = $1 AND is_active = true',
        [durationDays]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, durationDays }, 'Failed to find plans by duration');
      throw new RepositoryError('Failed to find plans by duration', error);
    }
  }
}
