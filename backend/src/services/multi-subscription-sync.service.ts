import { Pool } from 'pg';
import {
    REST_API,
} from '@remnawave/backend-contract';
import { RemnawaveService, type RemnawaveUserExtended } from './remnawave.service.js';
import { logger } from '../utils/logger.js';

/**
 * Sync result for a single user
 */
export interface UserSyncResult {
    telegramId: string;
    remnawaveUuid: string;
    username: string;
    status: 'linked' | 'created' | 'skipped' | 'error';
    message: string;
}

/**
 * Full sync report
 */
export interface SyncReport {
    totalProcessed: number;
    linked: number;
    created: number;
    skipped: number;
    errors: number;
    details: UserSyncResult[];
    startedAt: Date;
    completedAt: Date;
    durationMs: number;
}

/**
 * Service for synchronizing multiple Remnawave subscriptions
 */
export class MultiSubscriptionSyncService {
    private pool: Pool;
    private remnawaveService: RemnawaveService;

    constructor(pool: Pool) {
        this.pool = pool;
        this.remnawaveService = new RemnawaveService(pool);
    }

    /**
     * Synchronize all Remnawave users with rezeis database
     * Creates or updates RemnawaveUserLink records
     * @returns Sync report with detailed results
     */
    async syncAllUsers(): Promise<SyncReport> {
        const startedAt = new Date();
        const details: UserSyncResult[] = [];
        let linked = 0;
        let created = 0;
        let skipped = 0;
        let errors = 0;

        try {
            logger.info('Starting multi-subscription user sync');

            // Get all users from Remnawave
            const remnawaveUsers = await this.remnawaveService.getAllUsers(0, 10000);
            logger.info(`Fetched ${remnawaveUsers.length} users from Remnawave`);

            for (const user of remnawaveUsers) {
                try {
                    // Skip users without telegram ID
                    if (!user.telegramId) {
                        details.push({
                            telegramId: '',
                            remnawaveUuid: user.uuid,
                            username: user.username,
                            status: 'skipped',
                            message: 'No Telegram ID associated',
                        });
                        skipped++;
                        continue;
                    }

                    const telegramId = String(user.telegramId);
                    const result = await this.syncSingleUser(telegramId, user);
                    details.push(result);

                    if (result.status === 'linked') linked++;
                    else if (result.status === 'created') created++;
                    else if (result.status === 'skipped') skipped++;
                    else if (result.status === 'error') errors++;
                } catch (error) {
                    logger.error({ error, user }, 'Failed to sync user');
                    details.push({
                        telegramId: String(user.telegramId || ''),
                        remnawaveUuid: user.uuid,
                        username: user.username,
                        status: 'error',
                        message: error instanceof Error ? error.message : 'Unknown error',
                    });
                    errors++;
                }
            }

            const completedAt = new Date();
            const durationMs = completedAt.getTime() - startedAt.getTime();

            const report: SyncReport = {
                totalProcessed: remnawaveUsers.length,
                linked,
                created,
                skipped,
                errors,
                details,
                startedAt,
                completedAt,
                durationMs,
            };

            // Store sync report in database
            await this.storeSyncReport(report);

            logger.info({ report: { ...report, details: undefined } }, 'Multi-subscription sync completed');

            return report;
        } catch (error) {
            logger.error({ error }, 'Multi-subscription sync failed');
            throw error;
        }
    }

    /**
     * Sync a single user from Remnawave
     */
    private async syncSingleUser(
        telegramId: string,
        remnawaveUser: RemnawaveUserExtended
    ): Promise<UserSyncResult> {
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            // Check if user exists in rezeis database
            const userResult = await client.query(
                'SELECT id FROM users WHERE telegram_id = $1',
                [telegramId]
            );

            let userId: string;

            if (userResult.rows.length === 0) {
                // User doesn't exist in rezeis, create placeholder
                const newUserResult = await client.query(
                    `INSERT INTO users (username, telegram_id, role, is_active, created_at, updated_at)
                     VALUES ($1, $2, 'USER', true, NOW(), NOW())
                     RETURNING id`,
                    [remnawaveUser.username, telegramId]
                );
                userId = newUserResult.rows[0].id;
            } else {
                userId = userResult.rows[0].id;
            }

            // Check if link already exists
            const linkResult = await client.query(
                `SELECT id FROM remnawave_user_links 
                 WHERE telegram_id = $1 AND remnawave_uuid = $2`,
                [telegramId, remnawaveUser.uuid]
            );

            if (linkResult.rows.length > 0) {
                // Link exists, update it
                await client.query(
                    `UPDATE remnawave_user_links 
                     SET remnawave_username = $1, updated_at = NOW()
                     WHERE telegram_id = $2 AND remnawave_uuid = $3`,
                    [remnawaveUser.username, telegramId, remnawaveUser.uuid]
                );

                await client.query('COMMIT');

                return {
                    telegramId,
                    remnawaveUuid: remnawaveUser.uuid,
                    username: remnawaveUser.username,
                    status: 'linked',
                    message: 'Existing link updated',
                };
            }

            // Check if user has any primary link
            const primaryResult = await client.query(
                `SELECT id FROM remnawave_user_links 
                 WHERE user_id = $1 AND is_primary = true`,
                [userId]
            );

            const isPrimary = primaryResult.rows.length === 0;

            // Create new link
            await client.query(
                `INSERT INTO remnawave_user_links 
                 (user_id, remnawave_uuid, remnawave_username, telegram_id, is_primary, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
                [userId, remnawaveUser.uuid, remnawaveUser.username, telegramId, isPrimary]
            );

            await client.query('COMMIT');

            return {
                telegramId,
                remnawaveUuid: remnawaveUser.uuid,
                username: remnawaveUser.username,
                status: 'created',
                message: isPrimary ? 'New primary link created' : 'New secondary link created',
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get all Remnawave users by Telegram ID
     */
    async getUsersByTelegramId(telegramId: string): Promise<RemnawaveUserExtended[]> {
        try {
            const response = await this.remnawaveService.getUsersByTelegramId(telegramId);
            return response;
        } catch (error) {
            logger.error({ error, telegramId }, 'Failed to get users by Telegram ID');
            throw error;
        }
    }

    /**
     * Get all Remnawave profiles linked to a Telegram ID from rezeis database
     */
    async getLinkedProfiles(telegramId: string): Promise<Array<{
        id: string;
        userId: string;
        remnawaveUuid: string;
        remnawaveUsername: string | null;
        isPrimary: boolean;
        createdAt: Date;
    }>> {
        const result = await this.pool.query(
            `SELECT id, user_id, remnawave_uuid, remnawave_username, is_primary, created_at
             FROM remnawave_user_links
             WHERE telegram_id = $1
             ORDER BY is_primary DESC, created_at ASC`,
            [telegramId]
        );

        return result.rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            remnawaveUuid: row.remnawave_uuid,
            remnawaveUsername: row.remnawave_username,
            isPrimary: row.is_primary,
            createdAt: row.created_at,
        }));
    }

    /**
     * Link a Telegram ID to a Remnawave profile (admin operation)
     */
    async linkTelegramToRemnawave(
        remnawaveUuid: string,
        telegramId: string,
        userId?: string
    ): Promise<UserSyncResult> {
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            // Get user from Remnawave
            const remnawaveUser = await this.remnawaveService.getUserByUuid(remnawaveUuid);

            if (!remnawaveUser) {
                throw new Error(`Remnawave user with UUID ${remnawaveUuid} not found`);
            }

            // Determine user ID
            let targetUserId = userId;

            if (!targetUserId) {
                // Find user by telegram ID
                const userResult = await client.query(
                    'SELECT id FROM users WHERE telegram_id = $1',
                    [telegramId]
                );

                if (userResult.rows.length === 0) {
                    // Create placeholder user
                    const newUserResult = await client.query(
                        `INSERT INTO users (username, telegram_id, role, is_active, created_at, updated_at)
                         VALUES ($1, $2, 'USER', true, NOW(), NOW())
                         RETURNING id`,
                        [remnawaveUser.username, telegramId]
                    );
                    targetUserId = newUserResult.rows[0].id;
                } else {
                    targetUserId = userResult.rows[0].id;
                }
            }

            // Check if link already exists
            const existingLink = await client.query(
                `SELECT id FROM remnawave_user_links 
                 WHERE remnawave_uuid = $1`,
                [remnawaveUuid]
            );

            if (existingLink.rows.length > 0) {
                // Update existing link
                await client.query(
                    `UPDATE remnawave_user_links 
                     SET telegram_id = $1, user_id = $2, updated_at = NOW()
                     WHERE remnawave_uuid = $3`,
                    [telegramId, targetUserId, remnawaveUuid]
                );

                await client.query('COMMIT');

                return {
                    telegramId,
                    remnawaveUuid,
                    username: remnawaveUser.username,
                    status: 'linked',
                    message: 'Link updated successfully',
                };
            }

            // Check if user has primary link
            const primaryResult = await client.query(
                `SELECT id FROM remnawave_user_links 
                 WHERE user_id = $1 AND is_primary = true`,
                [targetUserId]
            );

            const isPrimary = primaryResult.rows.length === 0;

            // Create new link
            await client.query(
                `INSERT INTO remnawave_user_links 
                 (user_id, remnawave_uuid, remnawave_username, telegram_id, is_primary, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
                [targetUserId, remnawaveUuid, remnawaveUser.username, telegramId, isPrimary]
            );

            await client.query('COMMIT');

            return {
                telegramId,
                remnawaveUuid,
                username: remnawaveUser.username,
                status: 'created',
                message: isPrimary ? 'Primary link created' : 'Secondary link created',
            };
        } catch (error) {
            await client.query('ROLLBACK');
            logger.error({ error, remnawaveUuid, telegramId }, 'Failed to link Telegram to Remnawave');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get subscription info from Remnawave by short UUID
     */
    async getSubscriptionInfo(shortUuid: string): Promise<unknown> {
        try {
            // Use the backend-contract route
            const url = REST_API.SUBSCRIPTION.GET_INFO(shortUuid);
            const response = await fetch(url, {
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to get subscription info: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            logger.error({ error, shortUuid }, 'Failed to get subscription info');
            throw error;
        }
    }

    /**
     * Get all subscriptions for a user (from rezeis DB)
     */
    async getAllUserSubscriptions(userId: string): Promise<Array<{
        id: string;
        planId: string;
        planName: string;
        status: string;
        startDate: Date;
        endDate: Date;
        remnawaveUuid: string | null;
        trafficLimitGb: number | null;
        trafficUsedGb: number;
        subscriptionType: string;
    }>> {
        const result = await this.pool.query(
            `SELECT s.id, s.plan_id, p.name as plan_name, s.status, 
                    s.start_date, s.end_date, s.remnawave_uuid,
                    s.traffic_limit_gb, s.traffic_used_gb, s.subscription_type
             FROM subscriptions s
             LEFT JOIN plans p ON s.plan_id = p.id
             WHERE s.user_id = $1
             ORDER BY s.created_at DESC`,
            [userId]
        );

        return result.rows.map(row => ({
            id: row.id,
            planId: row.plan_id,
            planName: row.plan_name,
            status: row.status,
            startDate: row.start_date,
            endDate: row.end_date,
            remnawaveUuid: row.remnawave_uuid,
            trafficLimitGb: row.traffic_limit_gb,
            trafficUsedGb: row.traffic_used_gb,
            subscriptionType: row.subscription_type,
        }));
    }

    /**
     * Store sync report in database
     */
    private async storeSyncReport(report: SyncReport): Promise<void> {
        try {
            await this.pool.query(
                `INSERT INTO sync_logs 
                 (sync_type, status, details, started_at, completed_at, error_message)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    'multi_subscription_sync',
                    report.errors > 0 ? 'completed_with_errors' : 'completed',
                    JSON.stringify({
                        totalProcessed: report.totalProcessed,
                        linked: report.linked,
                        created: report.created,
                        skipped: report.skipped,
                        errors: report.errors,
                        durationMs: report.durationMs,
                    }),
                    report.startedAt,
                    report.completedAt,
                    report.errors > 0 ? `${report.errors} errors occurred` : null,
                ]
            );
        } catch (error) {
            logger.error({ error }, 'Failed to store sync report');
        }
    }

    /**
     * Get all user links with pagination
     */
    async getAllUserLinks(page = 1, limit = 50): Promise<{
        data: Array<{
            id: string;
            userId: string;
            telegramId: string;
            remnawaveUuid: string;
            remnawaveUsername: string | null;
            isPrimary: boolean;
            createdAt: Date;
            userUsername?: string;
        }>;
        total: number;
        page: number;
        limit: number;
        totalPages: number;
    }> {
        const offset = (page - 1) * limit;

        const [dataResult, countResult] = await Promise.all([
            this.pool.query(
                `SELECT rul.*, u.username as user_username
                 FROM remnawave_user_links rul
                 LEFT JOIN users u ON rul.user_id = u.id
                 ORDER BY rul.created_at DESC
                 LIMIT $1 OFFSET $2`,
                [limit, offset]
            ),
            this.pool.query('SELECT COUNT(*) as total FROM remnawave_user_links'),
        ]);

        const total = parseInt(countResult.rows[0].total, 10);
        const totalPages = Math.ceil(total / limit);

        return {
            data: dataResult.rows.map(row => ({
                id: row.id,
                userId: row.user_id,
                telegramId: row.telegram_id,
                remnawaveUuid: row.remnawave_uuid,
                remnawaveUsername: row.remnawave_username,
                isPrimary: row.is_primary,
                createdAt: row.created_at,
                userUsername: row.user_username,
            })),
            total,
            page,
            limit,
            totalPages,
        };
    }

    /**
     * Set a link as primary for a user
     */
    async setPrimaryLink(userId: string, linkId: string): Promise<void> {
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            // Clear existing primary
            await client.query(
                `UPDATE remnawave_user_links 
                 SET is_primary = false, updated_at = NOW()
                 WHERE user_id = $1`,
                [userId]
            );

            // Set new primary
            await client.query(
                `UPDATE remnawave_user_links 
                 SET is_primary = true, updated_at = NOW()
                 WHERE id = $1 AND user_id = $2`,
                [linkId, userId]
            );

            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Delete a user link
     */
    async deleteLink(linkId: string): Promise<void> {
        await this.pool.query(
            'DELETE FROM remnawave_user_links WHERE id = $1',
            [linkId]
        );
    }
}

/**
 * Factory function to create MultiSubscriptionSyncService instance
 */
export function createMultiSubscriptionSyncService(pool: Pool): MultiSubscriptionSyncService {
    return new MultiSubscriptionSyncService(pool);
}
