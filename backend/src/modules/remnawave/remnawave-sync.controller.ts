import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { MultiSubscriptionSyncService } from '../../services/multi-subscription-sync.service.js';
import { RemnawaveService } from '../../services/remnawave.service.js';
import { logger } from '../../utils/logger.js';

/**
 * Controller for multi-subscription synchronization endpoints
 */
export class RemnawaveSyncController {
    private readonly syncService: MultiSubscriptionSyncService;
    private readonly remnawaveService: RemnawaveService;

    constructor(pool: Pool) {
        this.syncService = new MultiSubscriptionSyncService(pool);
        this.remnawaveService = new RemnawaveService(pool);
    }

    /**
     * Get all Remnawave users by Telegram ID
     * GET /api/remnawave/users/by-telegram/:telegramId
     */
    async getUsersByTelegramId(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> {
        try {
            const params = request.params as { telegramId: string };
            const { telegramId } = params;

            if (!telegramId || !/^\d+$/.test(telegramId)) {
                reply.status(400).send({
                    success: false,
                    error: 'Invalid Telegram ID format',
                });
                return;
            }

            // Get users from Remnawave
            const remnawaveUsers = await this.syncService.getUsersByTelegramId(telegramId);

            // Get linked profiles from rezeis database
            const linkedProfiles = await this.syncService.getLinkedProfiles(telegramId);

            // Combine the data
            const combinedData = remnawaveUsers.map(user => {
                const linkedProfile = linkedProfiles.find(
                    p => p.remnawaveUuid === user.uuid
                );

                return {
                    ...user,
                    isLinked: !!linkedProfile,
                    linkId: linkedProfile?.id || null,
                    isPrimary: linkedProfile?.isPrimary || false,
                };
            });

            reply.send({
                success: true,
                data: {
                    telegramId,
                    users: combinedData,
                    totalCount: combinedData.length,
                    linkedCount: linkedProfiles.length,
                },
            });
        } catch (error) {
            logger.error({ error, params: request.params }, 'Failed to get users by Telegram ID');
            reply.status(500).send({
                success: false,
                error: 'Failed to get users by Telegram ID',
            });
        }
    }

    /**
     * Synchronize all Remnawave users with rezeis
     * POST /api/remnawave/sync/users
     */
    async syncAllUsers(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        void request;
        try {
            const report = await this.syncService.syncAllUsers();

            reply.send({
                success: true,
                data: {
                    report: {
                        totalProcessed: report.totalProcessed,
                        linked: report.linked,
                        created: report.created,
                        skipped: report.skipped,
                        errors: report.errors,
                        startedAt: report.startedAt,
                        completedAt: report.completedAt,
                        durationMs: report.durationMs,
                    },
                    details: report.details,
                },
            });
        } catch (error) {
            logger.error({ error }, 'Failed to sync all users');
            reply.status(500).send({
                success: false,
                error: 'Failed to synchronize users',
            });
        }
    }

    /**
     * Link Telegram ID to a Remnawave profile
     * POST /api/remnawave/users/:uuid/link-telegram
     */
    async linkTelegramToUser(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> {
        try {
            const params = request.params as { uuid: string };
            const body = request.body as { telegramId: string; userId?: string };
            const { uuid } = params;
            const { telegramId, userId } = body;

            if (!uuid) {
                reply.status(400).send({
                    success: false,
                    error: 'Remnawave UUID is required',
                });
                return;
            }

            if (!telegramId || !/^\d+$/.test(telegramId)) {
                reply.status(400).send({
                    success: false,
                    error: 'Valid Telegram ID is required',
                });
                return;
            }

            const result = await this.syncService.linkTelegramToRemnawave(
                uuid,
                telegramId,
                userId
            );

            reply.send({
                success: true,
                data: result,
            });
        } catch (error) {
            logger.error({ error, params: request.params, body: request.body }, 'Failed to link Telegram to user');
            reply.status(500).send({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to link Telegram to user',
            });
        }
    }

    /**
     * Get all user links with pagination
     * GET /api/remnawave/user-links
     */
    async getAllUserLinks(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> {
        try {
            const query = request.query as { page?: string; limit?: string };
            const page = parseInt(query.page || '1', 10);
            const limit = Math.min(parseInt(query.limit || '50', 10), 100);

            const result = await this.syncService.getAllUserLinks(page, limit);

            reply.send({
                success: true,
                data: result,
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get user links');
            reply.status(500).send({
                success: false,
                error: 'Failed to get user links',
            });
        }
    }

    /**
     * Set a link as primary
     * PATCH /api/remnawave/user-links/:id/primary
     */
    async setPrimaryLink(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> {
        try {
            const params = request.params as { id: string };
            const body = request.body as { userId: string };
            const { id } = params;
            const { userId } = body;

            if (!id || !userId) {
                reply.status(400).send({
                    success: false,
                    error: 'Link ID and User ID are required',
                });
                return;
            }

            await this.syncService.setPrimaryLink(userId, id);

            reply.send({
                success: true,
                message: 'Primary link updated successfully',
            });
        } catch (error) {
            logger.error({ error, params: request.params }, 'Failed to set primary link');
            reply.status(500).send({
                success: false,
                error: 'Failed to set primary link',
            });
        }
    }

    /**
     * Delete a user link
     * DELETE /api/remnawave/user-links/:id
     */
    async deleteLink(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> {
        try {
            const params = request.params as { id: string };
            const { id } = params;

            if (!id) {
                reply.status(400).send({
                    success: false,
                    error: 'Link ID is required',
                });
                return;
            }

            await this.syncService.deleteLink(id);

            reply.send({
                success: true,
                message: 'Link deleted successfully',
            });
        } catch (error) {
            logger.error({ error, params: request.params }, 'Failed to delete link');
            reply.status(500).send({
                success: false,
                error: 'Failed to delete link',
            });
        }
    }

    /**
     * Get sync status and recent logs
     * GET /api/remnawave/sync/status
     */
    async getSyncStatus(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        void request;
        try {
            // Get connection status
            const connectionResult = await this.remnawaveService.testConnection();

            reply.send({
                success: true,
                data: {
                    connected: connectionResult.success,
                    message: connectionResult.message,
                },
            });
        } catch (error) {
            logger.error({ error }, 'Failed to get sync status');
            reply.status(500).send({
                success: false,
                error: 'Failed to get sync status',
            });
        }
    }
}
