import { FastifyInstance } from 'fastify';
import { RemnawaveSyncController } from './remnawave-sync.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { requireSuperAdmin } from '../../middleware/super-admin.middleware.js';

/**
 * Register multi-subscription sync routes
 * These routes require super admin access for sensitive operations
 */
export async function remnawaveSyncRoutes(app: FastifyInstance): Promise<void> {
    const controller = new RemnawaveSyncController(app.pg);

    // ==========================================
    // USER LINKS MANAGEMENT (Super Admin only)
    // ==========================================

    /**
     * GET /api/remnawave/users/by-telegram/:telegramId
     * Get all Remnawave users by Telegram ID
     */
    app.get(
        '/remnawave/users/by-telegram/:telegramId',
        { preHandler: [authenticate, requireSuperAdmin] },
        (req, reply) => controller.getUsersByTelegramId(req, reply)
    );

    /**
     * POST /api/remnawave/sync/users
     * Synchronize all Remnawave users with rezeis
     */
    app.post(
        '/remnawave/sync/users',
        { preHandler: [authenticate, requireSuperAdmin] },
        (req, reply) => controller.syncAllUsers(req, reply)
    );

    /**
     * POST /api/remnawave/users/:uuid/link-telegram
     * Link Telegram ID to a Remnawave profile
     */
    app.post(
        '/remnawave/users/:uuid/link-telegram',
        { preHandler: [authenticate, requireSuperAdmin] },
        (req, reply) => controller.linkTelegramToUser(req, reply)
    );

    /**
     * GET /api/remnawave/user-links
     * Get all user links with pagination
     */
    app.get(
        '/remnawave/user-links',
        { preHandler: [authenticate, requireSuperAdmin] },
        (req, reply) => controller.getAllUserLinks(req, reply)
    );

    /**
     * PATCH /api/remnawave/user-links/:id/primary
     * Set a link as primary
     */
    app.patch(
        '/remnawave/user-links/:id/primary',
        { preHandler: [authenticate, requireSuperAdmin] },
        (req, reply) => controller.setPrimaryLink(req, reply)
    );

    /**
     * DELETE /api/remnawave/user-links/:id
     * Delete a user link
     */
    app.delete(
        '/remnawave/user-links/:id',
        { preHandler: [authenticate, requireSuperAdmin] },
        (req, reply) => controller.deleteLink(req, reply)
    );

    /**
     * GET /api/remnawave/sync/status
     * Get sync status (available to all authenticated users)
     */
    app.get(
        '/remnawave/sync/status',
        { preHandler: authenticate },
        (req, reply) => controller.getSyncStatus(req, reply)
    );
}
