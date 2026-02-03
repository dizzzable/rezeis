import {
    USERS_ROUTES,
} from '@remnawave/backend-contract';
import { RemnawaveService, type RemnawaveUserExtended } from './remnawave.service.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.js';

// Get Prisma transaction type from the client
type PrismaTransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

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
 * Service for synchronizing multiple Remnawave subscriptions using Prisma
 */
export class MultiSubscriptionSyncPrismaService {
    private remnawaveService: RemnawaveService;

    constructor() {
        this.remnawaveService = new RemnawaveService();
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
            logger.info('Starting multi-subscription user sync with Prisma');

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
        return await prisma.$transaction(async (tx: PrismaTransactionClient): Promise<UserSyncResult> => {
            // Check if user exists in rezeis database
            let user = await tx.user.findUnique({
                where: { telegram_id: telegramId },
            });

            let userId: string;

            if (!user) {
                // User doesn't exist in rezeis, create placeholder
                user = await tx.user.create({
                    data: {
                        username: remnawaveUser.username,
                        telegram_id: telegramId,
                        role: 'USER' as const,
                        is_active: true,
                    },
                });
                userId = user.id;
            } else {
                userId = user.id;
            }

            // Check if link already exists
            const existingLink = await tx.remnawaveUserLink.findFirst({
                where: {
                    telegram_id: telegramId,
                    remnawave_uuid: remnawaveUser.uuid,
                },
            });

            if (existingLink) {
                // Link exists, update it
                await tx.remnawaveUserLink.update({
                    where: { id: existingLink.id },
                    data: {
                        remnawave_username: remnawaveUser.username,
                        updated_at: new Date(),
                    },
                });

                return {
                    telegramId,
                    remnawaveUuid: remnawaveUser.uuid,
                    username: remnawaveUser.username,
                    status: 'linked',
                    message: 'Existing link updated',
                };
            }

            // Check if user has any primary link
            const primaryLink = await tx.remnawaveUserLink.findFirst({
                where: {
                    user_id: userId,
                    is_primary: true,
                },
            });

            const isPrimary = !primaryLink;

            // Create new link
            await tx.remnawaveUserLink.create({
                data: {
                    user_id: userId,
                    remnawave_uuid: remnawaveUser.uuid,
                    remnawave_username: remnawaveUser.username,
                    telegram_id: telegramId,
                    is_primary: isPrimary,
                },
            });

            return {
                telegramId,
                remnawaveUuid: remnawaveUser.uuid,
                username: remnawaveUser.username,
                status: 'created',
                message: isPrimary ? 'New primary link created' : 'New secondary link created',
            };
        });
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
        const links = await prisma.remnawaveUserLink.findMany({
            where: { telegram_id: telegramId },
            orderBy: [
                { is_primary: 'desc' },
                { created_at: 'asc' },
            ],
        });

        return links.map((link: { id: string; user_id: string; remnawave_uuid: string; remnawave_username: string | null; is_primary: boolean; created_at: Date }) => ({
            id: link.id,
            userId: link.user_id,
            remnawaveUuid: link.remnawave_uuid,
            remnawaveUsername: link.remnawave_username,
            isPrimary: link.is_primary,
            createdAt: link.created_at,
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
        return await prisma.$transaction(async (tx: PrismaTransactionClient): Promise<UserSyncResult> => {
            // Get user from Remnawave
            const remnawaveUser = await this.remnawaveService.getUserByUuid(remnawaveUuid);

            if (!remnawaveUser) {
                throw new Error(`Remnawave user with UUID ${remnawaveUuid} not found`);
            }

            // Determine user ID
            let targetUserId = userId;

            if (!targetUserId) {
                // Find user by telegram ID
                let user = await tx.user.findUnique({
                    where: { telegram_id: telegramId },
                });

                if (!user) {
                    // Create placeholder user
                    user = await tx.user.create({
                        data: {
                            username: remnawaveUser.username,
                            telegram_id: telegramId,
                            role: 'USER' as const,
                            is_active: true,
                        },
                    });
                }
                targetUserId = user.id;
            }

            // Check if link already exists
            const existingLink = await tx.remnawaveUserLink.findFirst({
                where: { remnawave_uuid: remnawaveUuid },
            });

            if (existingLink) {
                // Update existing link
                await tx.remnawaveUserLink.update({
                    where: { id: existingLink.id },
                    data: {
                        telegram_id: telegramId,
                        user_id: targetUserId,
                        updated_at: new Date(),
                    },
                });

                return {
                    telegramId,
                    remnawaveUuid,
                    username: remnawaveUser.username,
                    status: 'linked',
                    message: 'Link updated successfully',
                };
            }

            // Check if user has primary link
            const primaryLink = await tx.remnawaveUserLink.findFirst({
                where: {
                    user_id: targetUserId,
                    is_primary: true,
                },
            });

            const isPrimary = !primaryLink;

            // Create new link
            await tx.remnawaveUserLink.create({
                data: {
                    user_id: targetUserId,
                    remnawave_uuid: remnawaveUuid,
                    remnawave_username: remnawaveUser.username,
                    telegram_id: telegramId,
                    is_primary: isPrimary,
                },
            });

            return {
                telegramId,
                remnawaveUuid,
                username: remnawaveUser.username,
                status: 'created',
                message: isPrimary ? 'Primary link created' : 'Secondary link created',
            };
        });
    }

    /**
     * Get subscription info from Remnawave by short UUID
     */
    async getSubscriptionInfo(shortUuid: string): Promise<Record<string, unknown> | null> {
        try {
            // Use the backend-contract route
            const url = USERS_ROUTES.GET_BY.SHORT_UUID(shortUuid);
            const response = await fetch(url, {
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to get subscription info: ${response.status}`);
            }

            return (await response.json()) as Record<string, unknown>;
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
        const subscriptions = await prisma.subscription.findMany({
            where: { user_id: userId },
            include: {
                plan: true,
            },
            orderBy: { created_at: 'desc' },
        });

        return subscriptions.map((sub: { id: string; plan_id: string; plan: { name: string } | null; status: string; start_date: Date; end_date: Date; remnawave_uuid: string | null; traffic_limit_gb: number | null; traffic_used_gb: { toNumber(): number } | number; subscription_type: string }) => {
            const trafficUsed = sub.traffic_used_gb;
            return {
                id: sub.id,
                planId: sub.plan_id,
                planName: sub.plan?.name || 'Unknown',
                status: sub.status,
                startDate: sub.start_date,
                endDate: sub.end_date,
                remnawaveUuid: sub.remnawave_uuid,
                trafficLimitGb: sub.traffic_limit_gb,
                trafficUsedGb: typeof trafficUsed === 'number' ? trafficUsed : Number(trafficUsed),
                subscriptionType: sub.subscription_type,
            };
        });
    }

    /**
     * Store sync report in database
     */
    private async storeSyncReport(report: SyncReport): Promise<void> {
        try {
            await prisma.remnawaveSyncLog.create({
                data: {
                    sync_type: 'multi_subscription_sync',
                    status: report.errors > 0 ? 'COMPLETED' : 'COMPLETED',
                    details: {
                        totalProcessed: report.totalProcessed,
                        linked: report.linked,
                        created: report.created,
                        skipped: report.skipped,
                        errors: report.errors,
                        durationMs: report.durationMs,
                    },
                    error_message: report.errors > 0 ? `${report.errors} errors occurred` : null,
                    started_at: report.startedAt,
                    completed_at: report.completedAt,
                },
            });
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
        const skip = (page - 1) * limit;

        const [links, total] = await Promise.all([
            prisma.remnawaveUserLink.findMany({
                skip,
                take: limit,
                orderBy: { created_at: 'desc' },
                include: {
                    user: {
                        select: {
                            username: true,
                        },
                    },
                },
            }),
            prisma.remnawaveUserLink.count(),
        ]);

        const totalPages = Math.ceil(total / limit);

        return {
            data: links.map((link: { id: string; user_id: string; telegram_id: string; remnawave_uuid: string; remnawave_username: string | null; is_primary: boolean; created_at: Date; user?: { username: string } | null }) => ({
                id: link.id,
                userId: link.user_id,
                telegramId: link.telegram_id,
                remnawaveUuid: link.remnawave_uuid,
                remnawaveUsername: link.remnawave_username,
                isPrimary: link.is_primary,
                createdAt: link.created_at,
                userUsername: link.user?.username,
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
        await prisma.$transaction(async (tx: PrismaTransactionClient) => {
            // Clear existing primary
            await tx.remnawaveUserLink.updateMany({
                where: { user_id: userId },
                data: {
                    is_primary: false,
                    updated_at: new Date(),
                },
            });

            // Set new primary
            await tx.remnawaveUserLink.update({
                where: {
                    id: linkId,
                    user_id: userId,
                },
                data: {
                    is_primary: true,
                    updated_at: new Date(),
                },
            });
        });
    }

    /**
     * Delete a user link
     */
    async deleteLink(linkId: string): Promise<void> {
        await prisma.remnawaveUserLink.delete({
            where: { id: linkId },
        });
    }
}

/**
 * Factory function to create MultiSubscriptionSyncPrismaService instance
 */
export function createMultiSubscriptionSyncPrismaService(): MultiSubscriptionSyncPrismaService {
    return new MultiSubscriptionSyncPrismaService();
}
