import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { logger } from '../utils/logger.js';

/**
 * Repository error class
 */
export class RepositoryError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RepositoryError';
  }
}

/**
 * Pagination options interface
 */
export interface PaginationOptions {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated result interface
 */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Base repository abstract class
 * Provides common CRUD operations for all entities
 */
export abstract class BaseRepository<T extends QueryResultRow, CreateDTO, UpdateDTO> {
  protected abstract readonly tableName: string;
  protected readonly db: Pool;

  /**
   * Constructor
   * @param db - PostgreSQL pool instance
   */
  constructor(db: Pool) {
    this.db = db;
  }

  /**
   * Map database row to entity
   * @param row - Database row
   * @returns Entity instance
   */
  protected abstract mapRowToEntity(row: QueryResultRow): T;

  /**
   * Build where clause from filter object
   * @param where - Partial entity filter
   * @returns SQL where clause and parameters
   */
  protected buildWhereClause(where: Record<string, unknown>): { clause: string; params: unknown[]; paramIndex: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(where)) {
      if (value !== undefined && value !== null) {
        const columnName = this.camelToSnake(key);
        conditions.push(`${columnName} = $${paramIndex}`);
        params.push(value);
        paramIndex++;
      }
    }

    const clause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { clause, params, paramIndex };
  }

  /**
   * Convert camelCase to snake_case
   * @param str - camelCase string
   * @returns snake_case string
   */
  protected camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  /**
   * Convert snake_case to camelCase
   * @param str - snake_case string
   * @returns camelCase string
   */
  protected snakeToCamel(str: string): string {
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  /**
   * Find all entities
   * @returns Array of entities
   */
  async findAll(): Promise<T[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM ${this.tableName} ORDER BY created_at DESC`
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, table: this.tableName }, 'Failed to find all records');
      throw new RepositoryError(`Failed to find all records in ${this.tableName}`, error);
    }
  }

  /**
   * Find entity by ID
   * @param id - Entity ID
   * @returns Entity or null if not found
   */
  async findById(id: string): Promise<T | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM ${this.tableName} WHERE id = $1`,
        [id]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, table: this.tableName, id }, 'Failed to find record by ID');
      throw new RepositoryError(`Failed to find record by ID in ${this.tableName}`, error);
    }
  }

  /**
   * Find one entity by filter
   * @param where - Partial entity filter
   * @returns Entity or null if not found
   */
  async findOne(where: Partial<T>): Promise<T | null> {
    try {
      const { clause, params } = this.buildWhereClause(where as Record<string, unknown>);
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM ${this.tableName} ${clause} LIMIT 1`,
        params
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, table: this.tableName, where }, 'Failed to find one record');
      throw new RepositoryError(`Failed to find one record in ${this.tableName}`, error);
    }
  }

  /**
   * Create new entity
   * @param data - Create DTO
   * @returns Created entity
   */
  async create(data: CreateDTO): Promise<T> {
    try {
      const entries = Object.entries(data as Record<string, unknown>).filter(
        ([, value]) => value !== undefined && value !== null
      );
      const columns = entries.map(([key]) => this.camelToSnake(key));
      const values = entries.map(([, value]) => value);
      const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');

      const result = await this.db.query<QueryResultRow>(
        `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values
      );

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, table: this.tableName, data }, 'Failed to create record');
      throw new RepositoryError(`Failed to create record in ${this.tableName}`, error);
    }
  }

  /**
   * Update entity by ID
   * @param id - Entity ID
   * @param data - Update DTO
   * @returns Updated entity
   */
  async update(id: string, data: UpdateDTO): Promise<T> {
    try {
      const entries = Object.entries(data as Record<string, unknown>).filter(
        ([, value]) => value !== undefined && value !== null
      );

      if (entries.length === 0) {
        throw new RepositoryError('No fields to update');
      }

      const setClauses = entries.map(([key], index) => `${this.camelToSnake(key)} = $${index + 2}`);
      const values = entries.map(([, value]) => value);

      const result = await this.db.query<QueryResultRow>(
        `UPDATE ${this.tableName} SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, ...values]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Record with id ${id} not found in ${this.tableName}`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, table: this.tableName, id, data }, 'Failed to update record');
      throw new RepositoryError(`Failed to update record in ${this.tableName}`, error);
    }
  }

  /**
   * Delete entity by ID
   * @param id - Entity ID
   * @returns True if deleted, false otherwise
   */
  async delete(id: string): Promise<boolean> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `DELETE FROM ${this.tableName} WHERE id = $1 RETURNING id`,
        [id]
      );
      return result.rowCount !== null && result.rowCount > 0;
    } catch (error) {
      logger.error({ error, table: this.tableName, id }, 'Failed to delete record');
      throw new RepositoryError(`Failed to delete record from ${this.tableName}`, error);
    }
  }

  /**
   * Count entities with optional filter
   * @param where - Optional partial entity filter
   * @returns Count of entities
   */
  async count(where?: Partial<T>): Promise<number> {
    try {
      let sql = `SELECT COUNT(*) FROM ${this.tableName}`;
      const params: unknown[] = [];

      if (where && Object.keys(where).length > 0) {
        const { clause, params: whereParams } = this.buildWhereClause(where as Record<string, unknown>);
        sql += ` ${clause}`;
        params.push(...whereParams);
      }

      const result = await this.db.query<{ count: string }>(sql, params);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ error, table: this.tableName, where }, 'Failed to count records');
      throw new RepositoryError(`Failed to count records in ${this.tableName}`, error);
    }
  }

  /**
   * Check if entity exists by ID
   * @param id - Entity ID
   * @returns True if exists, false otherwise
   */
  async exists(id: string): Promise<boolean> {
    try {
      const result = await this.db.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM ${this.tableName} WHERE id = $1)`,
        [id]
      );
      return result.rows[0].exists;
    } catch (error) {
      logger.error({ error, table: this.tableName, id }, 'Failed to check record existence');
      throw new RepositoryError(`Failed to check record existence in ${this.tableName}`, error);
    }
  }

  /**
   * Find entities with pagination
   * @param options - Pagination options
   * @returns Paginated result
   */
  async findWithPagination(options: PaginationOptions): Promise<PaginatedResult<T>> {
    try {
      const { page, limit, sortBy = 'created_at', sortOrder = 'desc' } = options;
      const offset = (page - 1) * limit;
      const sortColumn = this.camelToSnake(sortBy);

      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM ${this.tableName}`
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const dataResult = await this.db.query<QueryResultRow>(
        `SELECT * FROM ${this.tableName} ORDER BY ${sortColumn} ${sortOrder.toUpperCase()} LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      return {
        data: dataResult.rows.map((row) => this.mapRowToEntity(row)),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    } catch (error) {
      logger.error({ error, table: this.tableName, options }, 'Failed to find records with pagination');
      throw new RepositoryError(`Failed to find records with pagination in ${this.tableName}`, error);
    }
  }

  /**
   * Execute queries within a transaction
   * @param callback - Function to execute within transaction
   * @returns Result of the callback
   */
  async withTransaction<R>(callback: (client: PoolClient) => Promise<R>): Promise<R> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Execute raw query
   * @param sql - SQL query string
   * @param params - Query parameters
   * @returns Query result
   */
  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    try {
      const result = await this.db.query<R>(sql, params);
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      logger.error({ error, sql, params }, 'Failed to execute query');
      throw new RepositoryError('Failed to execute query', error);
    }
  }
}
