import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticateMiddleware } from '../../middleware/auth.middleware.js';
import { logger } from '../../utils/logger.js';

/**
 * Trial settings interface
 */
interface TrialSettings {
  defaultTrialDays: number;
  maxTrialPerUser: number;
  maxTrialPerDevice: number;
  isTrialEnabled: boolean;
}

/**
 * Trial statistics interface
 */
interface TrialStats {
  totalTrialUsers: number;
  activeTrialUsers: number;
  trialConversions: number;
  conversionRate: number;
  trialUsageByDevice: Record<string, number>;
}

/**
 * Admin middleware to check if user is an admin
 */
async function adminMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = request.user;

  if (!user || user.role !== 'admin') {
    reply.status(403).send({ error: 'Forbidden - Admin access required' });
    return;
  }
}

/**
 * Trial management routes (admin only)
 * These endpoints allow admins to manage trial settings and user trial eligibility
 */
export async function trialRoutes(fastify: FastifyInstance): Promise<void> {
  // Apply authentication to all routes
  fastify.addHook('preHandler', authenticateMiddleware);

  /**
   * GET /api/admin/trial/settings
   * Get current trial settings
   */
  fastify.get('/settings', { preHandler: [authenticateMiddleware, adminMiddleware] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Note: Would need to implement trial settings service
      const settings: TrialSettings = {
        defaultTrialDays: 3,
        maxTrialPerUser: 1,
        maxTrialPerDevice: 1,
        isTrialEnabled: true,
      };

      return { settings };
    } catch (error) {
      logger.error({ error }, 'Failed to get trial settings');
      return reply.status(500).send({ error: 'Failed to get trial settings' });
    }
  });

  /**
   * PUT /api/admin/trial/settings
   * Update trial settings
   */
  fastify.put<{
    Body: TrialSettings;
  }>('/settings', { preHandler: [authenticateMiddleware, adminMiddleware] }, async (request: FastifyRequest<{
    Body: TrialSettings;
  }>, reply: FastifyReply) => {
    try {
      const settings = request.body;

      logger.info({ settings }, 'Updating trial settings');

      // Note: Would need to implement trial settings update
      const updated: TrialSettings = {
        defaultTrialDays: settings.defaultTrialDays || 3,
        maxTrialPerUser: settings.maxTrialPerUser || 1,
        maxTrialPerDevice: settings.maxTrialPerDevice || 1,
        isTrialEnabled: settings.isTrialEnabled ?? true,
      };

      return { settings: updated };
    } catch (error) {
      logger.error({ error }, 'Failed to update trial settings');
      return reply.status(500).send({ error: 'Failed to update trial settings' });
    }
  });

  /**
   * GET /api/admin/trial/stats
   * Get trial statistics
   */
  fastify.get('/stats', { preHandler: [authenticateMiddleware, adminMiddleware] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Note: Would need to implement trial statistics
      const stats: TrialStats = {
        totalTrialUsers: 0,
        activeTrialUsers: 0,
        trialConversions: 0,
        conversionRate: 0,
        trialUsageByDevice: {
          android: 0,
          iphone: 0,
          windows: 0,
          mac: 0,
        },
      };

      return { stats };
    } catch (error) {
      logger.error({ error }, 'Failed to get trial stats');
      return reply.status(500).send({ error: 'Failed to get trial stats' });
    }
  });

  /**
   * POST /api/admin/trial/reset-user
   * Reset trial eligibility for a specific user
   */
  fastify.post<{
    Body: { userId: string };
  }>('/reset-user', { preHandler: [authenticateMiddleware, adminMiddleware] }, async (request: FastifyRequest<{
    Body: { userId: string };
  }>, reply: FastifyReply) => {
    try {
      const { userId } = request.body;

      logger.info({ userId }, 'Resetting trial eligibility for user');

      // Note: Would need to implement trial reset in trial tracking repository

      return { success: true };
    } catch (error) {
      logger.error({ error }, 'Failed to reset user trial eligibility');
      return reply.status(500).send({ error: 'Failed to reset trial eligibility' });
    }
  });

  /**
   * POST /api/admin/trial/grant
   * Grant trial to a specific user manually
   */
  fastify.post<{
    Body: { userId: string; durationDays?: number };
  }>('/grant', { preHandler: [authenticateMiddleware, adminMiddleware] }, async (request: FastifyRequest<{
    Body: { userId: string; durationDays?: number };
  }>, reply: FastifyReply) => {
    try {
      const { userId, durationDays = 7 } = request.body;

      logger.info({ userId, durationDays }, 'Granting trial to user');

      // Note: Would need to implement trial grant in enhanced subscription service
      const subscription = {
        id: 'pending',
        userId,
        status: 'active',
        isTrial: true,
        trialDurationDays: durationDays,
      };

      return { success: true, subscription };
    } catch (error) {
      logger.error({ error }, 'Failed to grant trial to user');
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to grant trial',
      });
    }
  });
}
