import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createEnhancedSubscriptionService } from '../../services/subscription-enhanced.service.js';
import { createPricingService } from '../../services/pricing.service.js';
import type { DeviceType } from '../../entities/subscription.entity.js';
import { authenticateMiddleware } from '../../middleware/auth.middleware.js';
import { logger } from '../../utils/logger.js';

/**
 * Enhanced subscription routes for MiniApp client
 * These endpoints handle trial subscriptions, device management, and bulk operations
 */
export async function subscriptionEnhancedRoutes(fastify: FastifyInstance): Promise<void> {
  const enhancedSubscriptionService = createEnhancedSubscriptionService(fastify.pg);
  const pricingService = createPricingService(fastify.pg);

  // Apply authentication to all routes
  fastify.addHook('preHandler', authenticateMiddleware);

  /**
   * GET /api/client/subscriptions/enhanced
   * Get all subscriptions for the current user
   */
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;

      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const subscriptions = await enhancedSubscriptionService.getUserSubscriptions(userId);

      return { subscriptions };
    } catch (error) {
      logger.error({ error }, 'Failed to get user subscriptions');
      return reply.status(500).send({ error: 'Failed to get subscriptions' });
    }
  });

  /**
   * GET /api/client/subscriptions/enhanced/current
   * Get the current active subscription for the user
   */
  fastify.get('/current', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;

      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const subscription = await enhancedSubscriptionService.getCurrentSubscription(userId);

      return { subscription };
    } catch (error) {
      logger.error({ error }, 'Failed to get current subscription');
      return reply.status(500).send({ error: 'Failed to get current subscription' });
    }
  });

  /**
   * POST /api/client/subscriptions/enhanced/current
   * Set the current subscription for multi-subscription users
   */
  fastify.post<{
    Body: { subscriptionId: string };
  }>('/current', async (request: FastifyRequest<{
    Body: { subscriptionId: string };
  }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;

      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { subscriptionId } = request.body;

      await enhancedSubscriptionService.setCurrentSubscription(userId, subscriptionId);

      return { success: true };
    } catch (error) {
      logger.error({ error }, 'Failed to set current subscription');
      return reply.status(500).send({ error: 'Failed to set current subscription' });
    }
  });

  /**
   * GET /api/client/subscriptions/enhanced/trial/eligibility
   * Check if the user is eligible for a trial subscription
   */
  fastify.get('/trial/eligibility', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;

      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const deviceFingerprint = request.headers['x-device-fingerprint'] as string;

      const result = await enhancedSubscriptionService.checkTrialEligibility(userId, deviceFingerprint);

      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to check trial eligibility');
      return reply.status(500).send({ eligible: false, reason: 'Failed to check eligibility' });
    }
  });

  /**
   * POST /api/client/subscriptions/enhanced/trial
   * Create a trial subscription for the user
   */
  fastify.post<{
    Body: { deviceType?: string };
  }>('/trial', async (request: FastifyRequest<{
    Body: { deviceType?: string };
  }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;

      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { deviceType } = request.body;
      const ipAddress = request.ip;
      const deviceFingerprint = request.headers['x-device-fingerprint'] as string;

      const subscription = await enhancedSubscriptionService.createTrialSubscription(
        userId,
        deviceType as DeviceType,
        deviceFingerprint,
        ipAddress
      );

      return {
        success: true,
        subscription,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to create trial subscription');
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create trial subscription',
      });
    }
  });

  /**
   * POST /api/client/subscriptions/enhanced/:id/device
   * Set device type for a subscription
   */
  fastify.post<{
    Params: { id: string };
    Body: { deviceType: string };
  }>('/:id/device', async (request: FastifyRequest<{
    Params: { id: string };
    Body: { deviceType: string };
  }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;

      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { id } = request.params;
      const { deviceType } = request.body;

      const subscription = await enhancedSubscriptionService.setDeviceType(
        id,
        deviceType as DeviceType
      );

      return { subscription };
    } catch (error) {
      logger.error({ error }, 'Failed to set device type');
      return reply.status(500).send({ error: 'Failed to set device type' });
    }
  });

  /**
   * GET /api/client/subscriptions/enhanced/plans/compatible
   * Get plans compatible with a specific device type
   */
  fastify.get<{
    Querystring: { deviceType: string };
  }>('/plans/compatible', async (request: FastifyRequest<{
    Querystring: { deviceType: string };
  }>, reply: FastifyReply) => {
    try {
      const { deviceType } = request.query;

      const plans = await enhancedSubscriptionService.getDeviceCompatiblePlans(
        deviceType as DeviceType
      );

      return { plans };
    } catch (error) {
      logger.error({ error }, 'Failed to get compatible plans');
      return reply.status(500).send({ error: 'Failed to get compatible plans' });
    }
  });

  /**
   * POST /api/client/subscriptions/enhanced/bulk-renewal/calculate
   * Calculate the total price for bulk renewal
   */
  fastify.post<{
    Body: {
      subscriptionIds: string[];
      durationId: string;
      promocode?: string;
    };
  }>('/bulk-renewal/calculate', async (request: FastifyRequest<{
    Body: {
      subscriptionIds: string[];
      durationId: string;
      promocode?: string;
    };
  }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;

      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { subscriptionIds, durationId, promocode } = request.body;

      const durationDays = await pricingService.getPlanDurations('').then(
        (durations) => durations.find((d) => d.id === durationId)?.durationDays || 30
      );

      const breakdown = await enhancedSubscriptionService.calculateBulkRenewalPrice({
        userId,
        subscriptionIds,
        durationDays,
        gatewayId: '',
        promocode,
      });

      return breakdown;
    } catch (error) {
      logger.error({ error }, 'Failed to calculate bulk renewal price');
      return reply.status(500).send({ error: 'Failed to calculate price' });
    }
  });

  /**
   * POST /api/client/subscriptions/enhanced/bulk-renewal
   * Process bulk renewal of multiple subscriptions
   */
  fastify.post<{
    Body: {
      subscriptionIds: string[];
      durationId: string;
      gatewayId: string;
      promocode?: string;
    };
  }>('/bulk-renewal', async (request: FastifyRequest<{
    Body: {
      subscriptionIds: string[];
      durationId: string;
      gatewayId: string;
      promocode?: string;
    };
  }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;

      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { subscriptionIds, durationId, gatewayId, promocode } = request.body;

      const durationDays = await pricingService.getPlanDurations('').then(
        (durations) => durations.find((d) => d.id === durationId)?.durationDays || 30
      );

      const result = await enhancedSubscriptionService.processBulkRenewal({
        userId,
        subscriptionIds,
        durationDays,
        gatewayId,
        promocode,
      });

      if (!result.success) {
        return reply.status(400).send(result);
      }

      return result;
    } catch (error) {
      logger.error({ error }, 'Failed to process bulk renewal');
      return reply.status(500).send({
        success: false,
        error: 'Failed to process bulk renewal',
      });
    }
  });
}
