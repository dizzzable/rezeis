import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { MultiSubscriptionSyncService } from '../../services/multi-subscription-sync.service.js';
import { RemnawaveService } from '../../services/remnawave.service.js';
import { getPool } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

/**
 * Client subscriptions routes for Mini App
 * Provides endpoints for users to view all their subscriptions
 */
export async function clientSubscriptionsAllRoutes(fastify: FastifyInstance): Promise<void> {
    const syncService = new MultiSubscriptionSyncService(getPool());
    const remnawaveService = new RemnawaveService(getPool());

    /**
     * GET /api/client/subscriptions/all
     * Get all subscriptions for the current user including Remnawave profiles
     * This endpoint is designed for Mini App users
     */
    fastify.get('/all', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const userId = request.user?.userId;
            const telegramId = request.user?.telegramId;

            if (!userId) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }

            // Get local subscriptions
            const localSubscriptions = await syncService.getAllUserSubscriptions(userId);

            // Get linked Remnawave profiles
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let remnaProfiles: Record<string, any>[] = [];
            if (telegramId) {
                try {
                    const profiles = await syncService.getLinkedProfiles(telegramId);
                    
                    // Get detailed info for each profile
                    remnaProfiles = await Promise.all(
                        profiles.map(async (profile) => {
                            try {
                                const user = await remnawaveService.getUserByUuid(profile.remnawaveUuid);
                                return {
                                    ...profile,
                                    remnawaveUser: user,
                                    subscriptionUrl: user?.subscriptionUrl || null,
                                    status: user?.status || 'unknown',
                                    trafficUsed: user?.userTraffic?.usedTrafficBytes || 0,
                                    trafficLimit: user?.trafficLimitBytes || 0,
                                    expireAt: user?.expireAt || null,
                                };
                            } catch (err) {
                                logger.error({ err, profile }, 'Failed to get Remnawave user details');
                                return {
                                    ...profile,
                                    remnawaveUser: null,
                                    error: 'Failed to fetch details',
                                };
                            }
                        })
                    );
                } catch (err) {
                    logger.error({ err, userId, telegramId }, 'Failed to get linked profiles');
                }
            }

            // Combine local subscriptions with Remnawave profiles
            const combinedData = {
                localSubscriptions: localSubscriptions.map(sub => ({
                    id: sub.id,
                    planId: sub.planId,
                    planName: sub.planName,
                    status: sub.status,
                    startDate: sub.startDate,
                    endDate: sub.endDate,
                    remnawaveUuid: sub.remnawaveUuid,
                    trafficLimitGb: sub.trafficLimitGb,
                    trafficUsedGb: sub.trafficUsedGb,
                    subscriptionType: sub.subscriptionType,
                })),
                remnawaveProfiles: remnaProfiles,
                totalSubscriptions: localSubscriptions.length + remnaProfiles.length,
            };

            return reply.send({
                success: true,
                data: combinedData,
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get all subscriptions');
            return reply.status(500).send({
                success: false,
                error: 'Failed to get subscriptions',
            });
        }
    });

    /**
     * GET /api/client/subscriptions/remnawave
     * Get only Remnawave profiles for the current user
     */
    fastify.get('/remnawave', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const userId = request.user?.userId;
            const telegramId = request.user?.telegramId;

            if (!userId) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }

            if (!telegramId) {
                return reply.status(400).send({
                    error: 'No Telegram ID associated with account',
                });
            }

            // Get linked Remnawave profiles
            const profiles = await syncService.getLinkedProfiles(telegramId);

            // Get detailed info for each profile
            const detailedProfiles = await Promise.all(
                profiles.map(async (profile) => {
                    try {
                        const user = await remnawaveService.getUserByUuid(profile.remnawaveUuid);
                        return {
                            id: profile.id,
                            remnawaveUuid: profile.remnawaveUuid,
                            remnawaveUsername: profile.remnawaveUsername,
                            isPrimary: profile.isPrimary,
                            createdAt: profile.createdAt,
                            status: user?.status || 'unknown',
                            subscriptionUrl: user?.subscriptionUrl || null,
                            shortUuid: user?.shortUuid || null,
                            trafficUsed: user?.userTraffic?.usedTrafficBytes || 0,
                            trafficLimit: user?.trafficLimitBytes || 0,
                            expireAt: user?.expireAt?.toISOString() || null,
                        };
                    } catch (err) {
                        logger.error({ err, profile }, 'Failed to get Remnawave user details');
                        return {
                            id: profile.id,
                            remnawaveUuid: profile.remnawaveUuid,
                            remnawaveUsername: profile.remnawaveUsername,
                            isPrimary: profile.isPrimary,
                            createdAt: profile.createdAt,
                            error: 'Failed to fetch details',
                        };
                    }
                })
            );

            return reply.send({
                success: true,
                data: {
                    profiles: detailedProfiles,
                    totalCount: detailedProfiles.length,
                    primaryProfile: detailedProfiles.find(p => p.isPrimary) || null,
                },
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get Remnawave profiles');
            return reply.status(500).send({
                success: false,
                error: 'Failed to get Remnawave profiles',
            });
        }
    });

    /**
     * GET /api/client/subscriptions/by-telegram/:telegramId
     * Get subscriptions by Telegram ID (for Mini App with Telegram auth)
     * This allows fetching subscriptions using Telegram WebApp initData
     */
    fastify.get('/by-telegram/:telegramId', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const params = request.params as { telegramId: string };
            const { telegramId } = params;
            const userId = request.user?.userId;

            if (!userId) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }

            if (!telegramId || !/^\d+$/.test(telegramId)) {
                return reply.status(400).send({
                    error: 'Invalid Telegram ID format',
                });
            }

            // Get users from Remnawave by Telegram ID
            const remnawaveUsers = await syncService.getUsersByTelegramId(telegramId);

            // Get linked profiles from rezeis
            const linkedProfiles = await syncService.getLinkedProfiles(telegramId);

            // Combine data
            const combinedData = remnawaveUsers.map(user => {
                const linkedProfile = linkedProfiles.find(
                    (p: { remnawaveUuid: string }) => p.remnawaveUuid === user.uuid
                );

                return {
                    uuid: user.uuid,
                    shortUuid: user.shortUuid,
                    username: user.username,
                    status: user.status,
                    subscriptionUrl: user.subscriptionUrl,
                    expireAt: user.expireAt?.toISOString(),
                    trafficUsed: user.userTraffic?.usedTrafficBytes || 0,
                    trafficLimit: user.trafficLimitBytes,
                    isLinked: !!linkedProfile,
                    isPrimary: linkedProfile?.isPrimary || false,
                };
            });

            return reply.send({
                success: true,
                data: {
                    telegramId,
                    profiles: combinedData,
                    totalCount: combinedData.length,
                },
            });
        } catch (error) {
            logger.error({ error, params: request.params }, 'Failed to get subscriptions by Telegram ID');
            return reply.status(500).send({
                success: false,
                error: 'Failed to get subscriptions',
            });
        }
    });
}
