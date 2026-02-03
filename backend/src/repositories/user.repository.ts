import type { QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError, type PaginatedResult } from './base.repository.js';
import type { User, CreateUserDTO, UpdateUserDTO, UserFilters } from '../entities/user.entity.js';
import { logger } from '../utils/logger.js';

/**
 * User repository class
 * Handles all database operations for users
 */
export class UserRepository extends BaseRepository<User, CreateUserDTO, UpdateUserDTO> {
  protected readonly tableName = 'users';

  /**
   * Map database row to User entity
   * @param row - Database row
   * @returns User entity
   */
  protected mapRowToEntity(row: QueryResultRow): User {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      telegramId: row.telegram_id,
      firstName: row.first_name,
      lastName: row.last_name,
      photoUrl: row.photo_url,
      role: row.role,
      isActive: row.is_active,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find user by username
   * @param username - User username
   * @returns User or null if not found
   */
  async findByUsername(username: string): Promise<User | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM users WHERE username = $1',
        [username]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, username }, 'Failed to find user by username');
      throw new RepositoryError('Failed to find user by username', error);
    }
  }

  /**
   * Find user by Telegram ID
   * @param telegramId - Telegram user ID
   * @returns User or null if not found
   */
  async findByTelegramId(telegramId: string): Promise<User | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM users WHERE telegram_id = $1',
        [telegramId]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, telegramId }, 'Failed to find user by Telegram ID');
      throw new RepositoryError('Failed to find user by Telegram ID', error);
    }
  }

  /**
   * Find all active users
   * @returns Array of active users
   */
  async findActiveUsers(): Promise<User[]> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM users WHERE is_active = true ORDER BY created_at DESC'
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error }, 'Failed to find active users');
      throw new RepositoryError('Failed to find active users', error);
    }
  }

  /**
   * Update user's last login timestamp
   * @param userId - User ID
   */
  async updateLastLogin(userId: string): Promise<void> {
    try {
      await this.db.query(
        'UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1',
        [userId]
      );
    } catch (error) {
      logger.error({ error, userId }, 'Failed to update last login');
      throw new RepositoryError('Failed to update last login', error);
    }
  }

  /**
   * Search users by query (username, first name, last name)
   * @param query - Search query
   * @returns Array of matching users
   */
  async searchUsers(query: string): Promise<User[]> {
    try {
      const searchTerm = `%${query}%`;
      const result = await this.db.query<QueryResultRow>(
        `SELECT * FROM users 
         WHERE username ILIKE $1 
         OR first_name ILIKE $1 
         OR last_name ILIKE $1 
         ORDER BY created_at DESC`,
        [searchTerm]
      );
      return result.rows.map((row) => this.mapRowToEntity(row));
    } catch (error) {
      logger.error({ error, query }, 'Failed to search users');
      throw new RepositoryError('Failed to search users', error);
    }
  }

  /**
   * Get users with pagination and filters
   * @param page - Page number
   * @param limit - Items per page
   * @param filters - Optional filters
   * @returns Paginated users
   */
  async getUsersWithPagination(
    page: number,
    limit: number,
    filters?: UserFilters
  ): Promise<PaginatedResult<User>> {
    try {
      const offset = (page - 1) * limit;
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (filters?.role) {
        conditions.push(`role = $${paramIndex}`);
        params.push(filters.role);
        paramIndex++;
      }

      if (filters?.isActive !== undefined) {
        conditions.push(`is_active = $${paramIndex}`);
        params.push(filters.isActive);
        paramIndex++;
      }

      if (filters?.search) {
        conditions.push(`(username ILIKE $${paramIndex} OR first_name ILIKE $${paramIndex} OR last_name ILIKE $${paramIndex})`);
        params.push(`%${filters.search}%`);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countResult = await this.db.query<{ count: string }>(
        `SELECT COUNT(*) FROM users ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const dataResult = await this.db.query<QueryResultRow>(
        `SELECT * FROM users ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
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
      logger.error({ error, page, limit, filters }, 'Failed to get users with pagination');
      throw new RepositoryError('Failed to get users with pagination', error);
    }
  }

  /**
   * Find first admin user
   * @returns First admin user or null if no admins exist
   */
  async findFirstAdmin(): Promise<User | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM users WHERE role = $1 LIMIT 1',
        ['admin']
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error }, 'Failed to find first admin');
      throw new RepositoryError('Failed to find first admin', error);
    }
  }

  /**
   * Count users by role
   * @param role - User role
   * @returns Count of users with the role
   */
  async countByRole(role: string): Promise<number> {
    try {
      const result = await this.db.query<{ count: string }>(
        'SELECT COUNT(*) FROM users WHERE role = $1',
        [role]
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ error, role }, 'Failed to count users by role');
      throw new RepositoryError('Failed to count users by role', error);
    }
  }

  /**
   * Find or create user from Telegram data
   * @param telegramId - Telegram user ID
   * @param userData - User data from Telegram
   * @returns User entity
   */
  async findOrCreateFromTelegram(
    telegramId: string,
    userData: {
      username?: string;
      firstName?: string;
      lastName?: string;
      photoUrl?: string;
    }
  ): Promise<User> {
    try {
      const existingUser = await this.findByTelegramId(telegramId);

      if (existingUser) {
        const updateData: UpdateUserDTO = {
          firstName: userData.firstName,
          lastName: userData.lastName,
          photoUrl: userData.photoUrl,
        };
        return await this.update(existingUser.id, updateData);
      }

      const createData: CreateUserDTO = {
        username: userData.username || `tg_${telegramId}`,
        telegramId,
        firstName: userData.firstName,
        lastName: userData.lastName,
        photoUrl: userData.photoUrl,
        role: 'user',
        isActive: true,
      };

      return await this.create(createData);
    } catch (error) {
      logger.error({ error, telegramId, userData }, 'Failed to find or create user from Telegram');
      throw new RepositoryError('Failed to find or create user from Telegram', error);
    }
  }
}
