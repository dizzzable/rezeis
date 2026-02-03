import { getSessionManager } from '../config/session.js';
import { getPool } from '../config/database.js';
import { logger } from '../utils/logger.js';

/**
 * Cleanup job configuration
 */
interface CleanupConfig {
  /** Session max age in days (default: 30) */
  sessionMaxAgeDays: number;
  /** Log max age in days (default: 90) */
  logMaxAgeDays: number;
  /** Notification max age in days (default: 60) */
  notificationMaxAgeDays: number;
  /** Broadcast max age in days (default: 180) */
  broadcastMaxAgeDays: number;
}

/**
 * Default cleanup configuration
 */
const DEFAULT_CONFIG: CleanupConfig = {
  sessionMaxAgeDays: 30,
  logMaxAgeDays: 90,
  notificationMaxAgeDays: 60,
  broadcastMaxAgeDays: 180,
};

/**
 * Cleanup job for removing old data
 */
export class CleanupJob {
  private config: CleanupConfig;
  private isRunning: boolean = false;

  constructor(config: Partial<CleanupConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run all cleanup tasks
   */
  async run(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Cleanup job is already running');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      logger.info('Starting cleanup job...');

      await Promise.all([
        this.cleanupExpiredSessions(),
        this.cleanupOldNotifications(),
        this.cleanupOldBroadcasts(),
        this.cleanupRateLimitKeys(),
        this.cleanupCacheEntries(),
      ]);

      const duration = Date.now() - startTime;
      logger.info({ durationMs: duration }, 'Cleanup job completed');
    } catch (error) {
      logger.error({ error }, 'Cleanup job failed');
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Cleanup expired sessions from Valkey
   */
  private async cleanupExpiredSessions(): Promise<void> {
    try {
      const sessionManager = getSessionManager();
      const stats = await sessionManager.getSessionStats();
      
      logger.debug({ stats }, 'Session stats before cleanup');

      // Cleanup already handled by Valkey TTL, but we can check for any issues
      await sessionManager.cleanupExpiredSessions();

      logger.info('Expired sessions cleanup completed');
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup expired sessions');
    }
  }

  /**
   * Cleanup old notifications from database
   */
  private async cleanupOldNotifications(): Promise<void> {
    const pool = getPool();
    
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.notificationMaxAgeDays);

      const result = await pool.query(
        `DELETE FROM notifications 
         WHERE created_at < $1 
         AND is_read = true
         RETURNING id`,
        [cutoffDate]
      );

      if (result.rowCount && result.rowCount > 0) {
        logger.info({ deleted: result.rowCount }, 'Old notifications cleaned up');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup old notifications');
    }
  }

  /**
   * Cleanup old broadcasts from database
   */
  private async cleanupOldBroadcasts(): Promise<void> {
    const pool = getPool();
    
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.broadcastMaxAgeDays);

      // First delete related broadcast messages
      await pool.query(
        `DELETE FROM broadcast_messages 
         WHERE broadcast_id IN (
           SELECT id FROM broadcasts WHERE created_at < $1 AND status = 'completed'
         )`,
        [cutoffDate]
      );

      // Then delete old broadcasts
      const result = await pool.query(
        `DELETE FROM broadcasts 
         WHERE created_at < $1 
         AND status = 'completed'
         RETURNING id`,
        [cutoffDate]
      );

      if (result.rowCount && result.rowCount > 0) {
        logger.info({ deleted: result.rowCount }, 'Old broadcasts cleaned up');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup old broadcasts');
    }
  }

  /**
   * Cleanup old rate limit keys from Valkey
   * Note: Valkey-Glide BaseClient doesn't have scan method
   */
  private async cleanupRateLimitKeys(): Promise<void> {
    // Note: Valkey-Glide BaseClient doesn't have scan method
    // Rate limit keys have TTL and will expire automatically
    logger.debug('Rate limit keys cleanup skipped - keys expire automatically via TTL');
  }

  /**
   * Cleanup old cache entries
   * Note: Valkey-Glide BaseClient doesn't have scan method
   */
  private async cleanupCacheEntries(): Promise<void> {
    // Note: Valkey-Glide BaseClient doesn't have scan method
    // Cache entries have TTL and will expire automatically
    logger.debug('Cache entries cleanup skipped - entries expire automatically via TTL');
  }

  /**
   * Get cleanup statistics
   */
  async getStats(): Promise<{
    sessionStats: { total: number; active: number };
    rateLimitKeys: number;
    cacheEntries: number;
  }> {
    try {
      const sessionManager = getSessionManager();
      const sessionStats = await sessionManager.getSessionStats();

      return {
        sessionStats,
        rateLimitKeys: 0,
        cacheEntries: 0,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get cleanup stats');
      return {
        sessionStats: { total: 0, active: 0 },
        rateLimitKeys: 0,
        cacheEntries: 0,
      };
    }
  }
}

/**
 * Global cleanup job instance
 */
let cleanupJob: CleanupJob | null = null;

/**
 * Initialize cleanup job
 * @param config Cleanup configuration
 * @returns CleanupJob instance
 */
export function initializeCleanupJob(config?: Partial<CleanupConfig>): CleanupJob {
  cleanupJob = new CleanupJob(config);
  return cleanupJob;
}

/**
 * Get cleanup job instance
 * @returns CleanupJob instance
 */
export function getCleanupJob(): CleanupJob {
  if (!cleanupJob) {
    cleanupJob = new CleanupJob();
  }
  return cleanupJob;
}

/**
 * Schedule cleanup job to run at regular intervals
 * @param intervalMs Interval in milliseconds (default: 1 hour)
 */
export function scheduleCleanupJob(intervalMs: number = 60 * 60 * 1000): NodeJS.Timeout {
  const job = getCleanupJob();
  
  // Run immediately on start
  job.run().catch(error => {
    logger.error({ error }, 'Initial cleanup job failed');
  });

  // Schedule periodic runs
  const interval = setInterval(() => {
    job.run().catch(error => {
      logger.error({ error }, 'Scheduled cleanup job failed');
    });
  }, intervalMs);

  logger.info({ intervalMs }, 'Cleanup job scheduled');
  return interval;
}

/**
 * Stop scheduled cleanup job
 * @param interval Timeout interval to clear
 */
export function stopCleanupJob(interval: NodeJS.Timeout): void {
  clearInterval(interval);
  logger.info('Cleanup job stopped');
}
