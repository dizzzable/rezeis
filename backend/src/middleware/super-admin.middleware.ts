import type { FastifyRequest, FastifyReply } from 'fastify';
import { isSuperAdmin } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Extended request interface with super admin info
 */
interface SuperAdminRequest extends FastifyRequest {
    user?: {
        userId: string;
        username: string;
        role: string;
        telegramId?: string;
    };
}

/**
 * Middleware to check if user is super admin
 * Must be used after authenticate middleware
 * @param request Fastify request
 * @param reply Fastify reply
 */
export async function requireSuperAdmin(
    request: SuperAdminRequest,
    reply: FastifyReply
): Promise<void> {
    try {
        const user = request.user;

        if (!user) {
            reply.status(401).send({ error: 'Unauthorized - Authentication required' });
            return;
        }

        // Check if user has telegram ID in their profile
        // This requires extending the auth middleware to include telegramId
        const telegramId = user.telegramId;

        if (!telegramId) {
            // Fallback: check if user role is ADMIN
            if (user.role !== 'ADMIN') {
                reply.status(403).send({ error: 'Forbidden - Super admin access required' });
                return;
            }
            return;
        }

        // Check if telegram ID is in super admin list
        if (!isSuperAdmin(telegramId)) {
            logger.warn({ userId: user.userId, telegramId }, 'Non-super admin attempted super admin action');
            reply.status(403).send({ error: 'Forbidden - Super admin access required' });
            return;
        }
    } catch (error) {
        logger.error({ error }, 'Super admin check failed');
        reply.status(500).send({ error: 'Internal server error during authorization' });
    }
}

/**
 * Middleware to check if user is admin (either regular admin or super admin)
 * @param request Fastify request
 * @param reply Fastify reply
 */
export async function requireAdmin(
    request: SuperAdminRequest,
    reply: FastifyReply
): Promise<void> {
    try {
        const user = request.user;

        if (!user) {
            reply.status(401).send({ error: 'Unauthorized - Authentication required' });
            return;
        }

        // Check if user is admin role
        if (user.role !== 'ADMIN') {
            // Also check if user is super admin via telegram
            if (user.telegramId && isSuperAdmin(user.telegramId)) {
                return;
            }

            reply.status(403).send({ error: 'Forbidden - Admin access required' });
            return;
        }
    } catch (error) {
        logger.error({ error }, 'Admin check failed');
        reply.status(500).send({ error: 'Internal server error during authorization' });
    }
}

/**
 * Check if request user is super admin (for use in controllers)
 * @param request Fastify request
 * @returns true if user is super admin
 */
export function checkIsSuperAdmin(request: SuperAdminRequest): boolean {
    const user = request.user;

    if (!user) {
        return false;
    }

    if (user.telegramId && isSuperAdmin(user.telegramId)) {
        return true;
    }

    return false;
}

/**
 * Check if request user is admin (for use in controllers)
 * @param request Fastify request
 * @returns true if user is admin
 */
export function checkIsAdmin(request: SuperAdminRequest): boolean {
    const user = request.user;

    if (!user) {
        return false;
    }

    if (user.role === 'ADMIN') {
        return true;
    }

    if (user.telegramId && isSuperAdmin(user.telegramId)) {
        return true;
    }

    return false;
}
