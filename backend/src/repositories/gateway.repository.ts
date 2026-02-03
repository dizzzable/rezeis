import type { QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError } from './base.repository.js';
import type { Gateway, CreateGatewayDTO, UpdateGatewayDTO } from '../entities/gateway.entity.js';
import { logger } from '../utils/logger.js';

/**
 * Gateway repository class
 * Handles all database operations for gateways
 */
export class GatewayRepository extends BaseRepository<Gateway, CreateGatewayDTO, UpdateGatewayDTO> {
  protected readonly tableName = 'gateways';

  /**
   * Map database row to Gateway entity
   * @param row - Database row
   * @returns Gateway entity
   */
  protected mapRowToEntity(row: QueryResultRow): Gateway {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      isActive: row.is_active,
      isDefault: row.is_default,
      config: row.config || {},
      displayOrder: row.display_order,
      iconUrl: row.icon_url,
      description: row.description,
      supportedCurrencies: row.supported_currencies || ['USD'],
      minAmount: row.min_amount,
      maxAmount: row.max_amount,
      feePercent: row.fee_percent,
      feeFixed: row.fee_fixed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find all active gateways
   * @returns Array of active gateways
   */
  async findActive(): Promise<Gateway[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM gateways WHERE is_active = true ORDER BY display_order ASC, created_at DESC'
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error }, 'Failed to find active gateways');
      throw new RepositoryError('Failed to find active gateways', error);
    }
  }

  /**
   * Find default gateway
   * @returns Default gateway or null if not found
   */
  async findDefault(): Promise<Gateway | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM gateways WHERE is_default = true LIMIT 1'
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error }, 'Failed to find default gateway');
      throw new RepositoryError('Failed to find default gateway', error);
    }
  }

  /**
   * Clear default flag from all gateways
   * Used when setting a new default gateway
   * @returns Number of rows updated
   */
  async clearDefault(): Promise<number> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'UPDATE gateways SET is_default = false, updated_at = NOW() WHERE is_default = true RETURNING id'
      );
      return result.rowCount || 0;
    } catch (error) {
      logger.error({ error }, 'Failed to clear default gateway');
      throw new RepositoryError('Failed to clear default gateway', error);
    }
  }

  /**
   * Set gateway as default
   * @param id - Gateway ID
   * @returns Updated gateway
   */
  async setDefault(id: string): Promise<Gateway> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'UPDATE gateways SET is_default = true, updated_at = NOW() WHERE id = $1 RETURNING *',
        [id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Gateway with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id }, 'Failed to set default gateway');
      throw new RepositoryError('Failed to set default gateway', error);
    }
  }

  /**
   * Find gateways by type
   * @param type - Gateway type
   * @returns Array of gateways of specified type
   */
  async findByType(type: Gateway['type']): Promise<Gateway[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM gateways WHERE type = $1 ORDER BY display_order ASC',
        [type]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, type }, 'Failed to find gateways by type');
      throw new RepositoryError('Failed to find gateways by type', error);
    }
  }

  /**
   * Find gateway by name
   * @param name - Gateway name
   * @returns Gateway or null if not found
   */
  async findByName(name: string): Promise<Gateway | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM gateways WHERE name = $1',
        [name]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, name }, 'Failed to find gateway by name');
      throw new RepositoryError('Failed to find gateway by name', error);
    }
  }

  /**
   * Toggle gateway active status
   * @param id - Gateway ID
   * @returns Updated gateway
   */
  async toggleActive(id: string): Promise<Gateway> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE gateways 
         SET is_active = NOT is_active, updated_at = NOW() 
         WHERE id = $1 
         RETURNING *`,
        [id]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Gateway with id ${id} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, id }, 'Failed to toggle gateway active status');
      throw new RepositoryError('Failed to toggle gateway active status', error);
    }
  }
}
