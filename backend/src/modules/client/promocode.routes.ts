import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createPromocodeService } from '../../services/promocode.service.js';
import { authenticateMiddleware } from '../../middleware/auth.middleware.js';
import { logger } from '../../utils/logger.js';

/**
 * Promocode routes for MiniApp client
 * These endpoints handle promocode validation, application, and history
 */
export async function promocodeRoutes(fastify: FastifyInstance): Promise<void> {
  const promocodeService = createPromocodeService(fastify.pg);

  // Apply authentication to all routes
  fastify.addHook('preHandler', authenticateMiddleware);

  /**
   * GET /api/client/promocode/validate
   * Validate a promocode (for display purposes without activating it)
   */
  fastify.get<{
    Querystring: { code: string; planId?: string; amount?: number };
  }>('/validate', async (request: FastifyRequest<{
    Querystring: { code: string; planId?: string; amount?: number };
  }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;

      if (!userId) {
        return reply.status(401).send({ valid: false, error: 'Unauthorized' });
      }

      const { code, planId, amount } = request.query;

      const result = await promocodeService.validatePromocode(code, userId, planId, amount);

      if (!result.valid) {
        return reply.status(400).send({ valid: false, error: result.error });
      }

      return {
        valid: true,
        promocode: {
          code: result.promocode!.code,
          description: result.promocode!.description,
          reward: result.reward,
          discount: result.discount,
        },
      };
    } catch (error) {
      logger.error({ error }, 'Failed to validate promocode');
      return reply.status(500).send({ valid: false, error: 'Failed to validate promocode' });
    }
  });

  /**
   * POST /api/client/promocode/apply
   * Apply a promocode (activates the reward)
   */
  fastify.post<{
    Body: {
      code: string;
      subscriptionId?: string;
      amount?: number;
    };
  }>('/apply', async (request: FastifyRequest<{
    Body: {
      code: string;
      subscriptionId?: string;
      amount?: number;
    };
  }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;

      if (!userId) {
        return reply.status(401).send({ success: false, error: 'Unauthorized' });
      }

      const { code, subscriptionId, amount } = request.body;
      const deviceFingerprint = request.headers['x-device-fingerprint'] as string;
      const ipAddress = request.ip;

      const result = await promocodeService.applyPromocode(code, userId, {
        subscriptionId,
        amount,
        deviceFingerprint,
        ipAddress,
      });

      if (!result.success) {
        return reply.status(400).send({ success: false, error: result.error });
      }

      return {
        success: true,
        activation: result.activation,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to apply promocode');
      return reply.status(500).send({ success: false, error: 'Failed to apply promocode' });
    }
  });

  /**
   * GET /api/client/promocode/history
   * Get user's promocode activation history
   */
  fastify.get<{
    Querystring: { page?: number; limit?: number };
  }>('/history', async (request: FastifyRequest<{
    Querystring: { page?: number; limit?: number };
  }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;

      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const page = request.query.page || 1;
      const limit = request.query.limit || 10;

      // Note: Would need to implement these methods in the service
      // For now, return empty data structure
      const activations: unknown[] = [];
      const total = 0;

      return {
        data: activations,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get promocode history');
      return reply.status(500).send({ error: 'Failed to get promocode history' });
    }
  });

  /**
   * GET /api/client/promocode/available
   * Get available promocodes for the user
   */
  fastify.get('/available', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;

      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      // Note: Would need to implement this method in the service
      // For now, return empty array
      const promocodes: unknown[] = [];

      return { promocodes };
    } catch (error) {
      logger.error({ error }, 'Failed to get available promocodes');
      return reply.status(500).send({ error: 'Failed to get available promocodes' });
    }
  });
}
