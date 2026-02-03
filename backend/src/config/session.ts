import { getValkey } from './redis.js';
import { logger } from '../utils/logger.js';
import type { BaseClient } from '@valkey/valkey-glide';
import { TimeUnit } from '@valkey/valkey-glide';

/**
 * Convert GlideString to string
 */
function gs(value: import('@valkey/valkey-glide').GlideString): string {
  if (Buffer.isBuffer(value)) {
    return value.toString('utf-8');
  }
  return String(value);
}

/**
 * Session configuration
 */
interface SessionConfig {
  /** Session TTL in seconds (default: 7 days) */
  ttl: number;
  /** Session key prefix */
  prefix: string;
}

/**
 * Default session configuration
 */
const DEFAULT_CONFIG: SessionConfig = {
  ttl: 7 * 24 * 60 * 60, // 7 days in seconds
  prefix: 'session:',
};

/**
 * Session data interface
 */
export interface SessionData {
  userId: string;
  username: string;
  role: string;
  createdAt: number;
  lastAccessedAt: number;
}

/**
 * Session manager for handling user sessions with Valkey
 */
export class SessionManager {
  private valkey: BaseClient;
  private config: SessionConfig;

  constructor(config: Partial<SessionConfig> = {}) {
    this.valkey = getValkey();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Create a new session
   * @param sessionId Unique session ID
   * @param data Session data
   * @returns Session ID
   */
  async createSession(sessionId: string, data: Omit<SessionData, 'createdAt' | 'lastAccessedAt'>): Promise<string> {
    try {
      const now = Date.now();
      const sessionData: SessionData = {
        ...data,
        createdAt: now,
        lastAccessedAt: now,
      };

      const key = this.getKey(sessionId);
      // Valkey-Glide uses options format: { expiry: { type: TimeUnit, count: ttl } }
      await this.valkey.set(key, JSON.stringify(sessionData), {
        expiry: { type: TimeUnit.Seconds, count: this.config.ttl },
      });

      logger.debug({ sessionId, userId: data.userId }, 'Session created');
      return sessionId;
    } catch (error) {
      logger.error({ error, sessionId }, 'Failed to create session');
      throw error;
    }
  }

  /**
   * Get session data
   * @param sessionId Session ID
   * @returns Session data or null if not found/expired
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    try {
      const key = this.getKey(sessionId);
      const data = await this.valkey.get(key);

      if (!data) {
        return null;
      }

      const sessionData: SessionData = JSON.parse(gs(data));
      
      // Update last accessed time
      sessionData.lastAccessedAt = Date.now();
      await this.valkey.set(key, JSON.stringify(sessionData), {
        expiry: { type: TimeUnit.Seconds, count: this.config.ttl },
      });

      return sessionData;
    } catch (error) {
      logger.error({ error, sessionId }, 'Failed to get session');
      return null;
    }
  }

  /**
   * Delete a session
   * @param sessionId Session ID
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      const key = this.getKey(sessionId);
      await this.valkey.del([key]);
      logger.debug({ sessionId }, 'Session deleted');
    } catch (error) {
      logger.error({ error, sessionId }, 'Failed to delete session');
      throw error;
    }
  }

  /**
   * Refresh session TTL
   * @param sessionId Session ID
   */
  async refreshSession(sessionId: string): Promise<void> {
    try {
      const key = this.getKey(sessionId);
      const exists = await this.valkey.exists([key]);

      if (exists === 1) {
        await this.valkey.expire(key, this.config.ttl);
        logger.debug({ sessionId }, 'Session refreshed');
      }
    } catch (error) {
      logger.error({ error, sessionId }, 'Failed to refresh session');
    }
  }

  /**
   * Get all active sessions for a user
   * Note: Limited support in Valkey-Glide without scan. Returns empty array.
   * @param userId User ID
   * @returns Array of session IDs (currently always empty)
   */
  async getUserSessions(userId: string): Promise<string[]> {
    // Note: Valkey-Glide BaseClient doesn't have scan method
    // This functionality would require maintaining a user-to-sessions index
    logger.warn('getUserSessions not fully supported in Valkey-Glide without scan');
    void userId;
    return [];
  }

  /**
   * Delete all sessions for a user
   * Note: Limited support in Valkey-Glide without scan.
   * @param userId User ID
   */
  async deleteUserSessions(userId: string): Promise<void> {
    void userId;
    // Note: Valkey-Glide BaseClient doesn't have scan method
    // This functionality would require maintaining a user-to-sessions index
    logger.warn('deleteUserSessions not fully supported in Valkey-Glide without scan');
  }

  /**
   * Clean up expired sessions (runs as a scheduled task)
   * Note: Valkey handles expiration automatically
   */
  async cleanupExpiredSessions(): Promise<void> {
    // Note: Valkey-Glide BaseClient doesn't have scan method
    // Valkey handles TTL expiration automatically
    logger.debug('Valkey handles session expiration automatically via TTL');
  }

  /**
   * Get session statistics
   * Note: Limited support in Valkey-Glide without scan.
   * @returns Session statistics (currently always returns zeros)
   */
  async getSessionStats(): Promise<{ total: number; active: number }> {
    // Note: Valkey-Glide BaseClient doesn't have scan method
    // Would need to maintain session count in a separate key
    logger.warn('getSessionStats not fully supported in Valkey-Glide without scan');
    return { total: 0, active: 0 };
  }

  /**
   * Generate Valkey key for session
   * @param sessionId Session ID
   * @returns Full Valkey key
   */
  private getKey(sessionId: string): string {
    return `${this.config.prefix}${sessionId}`;
  }
}

/**
 * Global session manager instance
 */
let sessionManager: SessionManager | null = null;

/**
 * Initialize session manager
 * @param config Session configuration
 * @returns SessionManager instance
 */
export function initializeSessionManager(config?: Partial<SessionConfig>): SessionManager {
  sessionManager = new SessionManager(config);
  return sessionManager;
}

/**
 * Get session manager instance
 * @returns SessionManager instance
 * @throws Error if not initialized
 */
export function getSessionManager(): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager();
  }
  return sessionManager;
}

/**
 * Generate a random session ID
 * @returns Session ID
 */
export function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 15);
  return `${timestamp}-${random}`;
}
