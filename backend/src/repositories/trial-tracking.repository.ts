import type { QueryResultRow } from 'pg';
import { BaseRepository, RepositoryError } from './base.repository.js';
import type {
  TrialTracking,
  CreateTrialTrackingDTO,
  UpdateTrialTrackingDTO,
} from '../entities/subscription.entity.js';
import { logger } from '../utils/logger.js';

/**
 * TrialTracking repository class
 * Handles all database operations for trial tracking and abuse prevention
 */
export class TrialTrackingRepository extends BaseRepository<
  TrialTracking,
  CreateTrialTrackingDTO,
  UpdateTrialTrackingDTO
> {
  protected readonly tableName = 'trial_tracking';

  /**
   * Map database row to TrialTracking entity
   * @param row - Database row
   * @returns TrialTracking entity
   */
  protected mapRowToEntity(row: QueryResultRow): TrialTracking {
    return {
      id: row.id,
      userId: row.user_id,
      hasUsedTrial: row.has_used_trial,
      trialSubscriptionId: row.trial_subscription_id,
      trialActivatedAt: row.trial_activated_at,
      trialDurationDays: row.trial_duration_days,
      deviceFingerprint: row.device_fingerprint,
      phoneNumber: row.phone_number,
      ipAddress: row.ip_address,
      telegramId: row.telegram_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Find trial tracking by user ID
   * @param userId - User ID
   * @returns TrialTracking or null if not found
   */
  async findByUserId(userId: string): Promise<TrialTracking | null> {
    try {
      const result = await this.db.query<QueryResultRow>(
        'SELECT * FROM trial_tracking WHERE user_id = $1',
        [userId]
      );
      return result.rows[0] ? this.mapRowToEntity(result.rows[0]) : null;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to find trial tracking by user ID');
      throw new RepositoryError('Failed to find trial tracking by user ID', error);
    }
  }

  /**
   * Check if user has used trial
   * @param userId - User ID
   * @returns True if user has used trial
   */
  async hasUsedTrial(userId: string): Promise<boolean> {
    try {
      const result = await this.db.query<{ has_used_trial: boolean }>(
        'SELECT has_used_trial FROM trial_tracking WHERE user_id = $1',
        [userId]
      );
      return result.rows[0]?.has_used_trial ?? false;
    } catch (error) {
      logger.error({ error, userId }, 'Failed to check if user has used trial');
      throw new RepositoryError('Failed to check if user has used trial', error);
    }
  }

  /**
   * Check if device fingerprint has used trial (abuse prevention)
   * @param deviceFingerprint - Device fingerprint
   * @returns True if device has used trial
   */
  async hasDeviceUsedTrial(deviceFingerprint: string): Promise<boolean> {
    try {
      const result = await this.db.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM trial_tracking WHERE device_fingerprint = $1 AND has_used_trial = true)',
        [deviceFingerprint]
      );
      return result.rows[0]?.exists ?? false;
    } catch (error) {
      logger.error({ error, deviceFingerprint }, 'Failed to check if device has used trial');
      throw new RepositoryError('Failed to check if device has used trial', error);
    }
  }

  /**
   * Create or update trial tracking for a user
   * @param userId - User ID
   * @param data - Trial tracking data
   * @returns Created or updated trial tracking
   */
  async upsert(userId: string, data: CreateTrialTrackingDTO): Promise<TrialTracking> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `INSERT INTO trial_tracking 
          (user_id, device_fingerprint, phone_number, ip_address, telegram_id, trial_duration_days)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (user_id) 
          DO UPDATE SET 
            device_fingerprint = COALESCE($2, trial_tracking.device_fingerprint),
            phone_number = COALESCE($3, trial_tracking.phone_number),
            ip_address = COALESCE($4, trial_tracking.ip_address),
            telegram_id = COALESCE($5, trial_tracking.telegram_id),
            updated_at = NOW()
          RETURNING *`,
        [userId, data.deviceFingerprint, data.phoneNumber, data.ipAddress, data.telegramId, data.trialDurationDays ?? 3]
      );
      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, userId, data }, 'Failed to upsert trial tracking');
      throw new RepositoryError('Failed to upsert trial tracking', error);
    }
  }

  /**
   * Mark trial as used for a user
   * @param userId - User ID
   * @param subscriptionId - Trial subscription ID
   * @returns Updated trial tracking
   */
  async markTrialUsed(userId: string, subscriptionId: string): Promise<TrialTracking> {
    try {
      const result = await this.db.query<QueryResultRow>(
        `UPDATE trial_tracking 
          SET has_used_trial = true, 
              trial_subscription_id = $2,
              trial_activated_at = NOW(),
              updated_at = NOW()
          WHERE user_id = $1 
          RETURNING *`,
        [userId, subscriptionId]
      );

      if (result.rows.length === 0) {
        throw new RepositoryError(`Trial tracking for user ${userId} not found`);
      }

      return this.mapRowToEntity(result.rows[0]);
    } catch (error) {
      logger.error({ error, userId, subscriptionId }, 'Failed to mark trial as used');
      throw new RepositoryError('Failed to mark trial as used', error);
    }
  }
}
