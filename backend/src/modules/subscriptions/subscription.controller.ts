import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  createSubscriptionService,
  SubscriptionNotFoundError,
  InvalidSubscriptionDataError,
} from './subscription.service.js';
import { logger } from '../../utils/logger.js';
import type {
  CreateSubscriptionInput,
  UpdateSubscriptionInput,
  GetSubscriptionsQuery,
  SubscriptionParams,
  ExpiringSubscriptionsQuery,
} from './subscription.schemas.js';

/**
 * Handle get subscriptions request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetSubscriptions(
  request: FastifyRequest<{ Querystring: GetSubscriptionsQuery }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const subscriptionService = createSubscriptionService(request.server.pg);
    const result = await subscriptionService.getSubscriptions(request.query);

    reply.send({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get subscriptions');
    reply.status(500).send({
      success: false,
      error: 'Failed to get subscriptions',
    });
  }
}

/**
 * Handle get subscription by ID request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetSubscriptionById(
  request: FastifyRequest<{ Params: SubscriptionParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const subscriptionService = createSubscriptionService(request.server.pg);
    const subscription = await subscriptionService.getSubscriptionById(request.params.id);

    if (!subscription) {
      reply.status(404).send({
        success: false,
        error: 'Subscription not found',
      });
      return;
    }

    reply.send({
      success: true,
      data: subscription,
    });
  } catch (error) {
    logger.error({ error, subscriptionId: request.params.id }, 'Failed to get subscription');
    reply.status(500).send({
      success: false,
      error: 'Failed to get subscription',
    });
  }
}

/**
 * Handle create subscription request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleCreateSubscription(
  request: FastifyRequest<{ Body: CreateSubscriptionInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const subscriptionService = createSubscriptionService(request.server.pg);
    const subscription = await subscriptionService.createSubscription(request.body);

    reply.status(201).send({
      success: true,
      data: subscription,
      message: 'Subscription created successfully',
    });
  } catch (error) {
    if (error instanceof InvalidSubscriptionDataError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error }, 'Failed to create subscription');
    reply.status(500).send({
      success: false,
      error: 'Failed to create subscription',
    });
  }
}

/**
 * Handle update subscription request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleUpdateSubscription(
  request: FastifyRequest<{ Params: SubscriptionParams; Body: UpdateSubscriptionInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const subscriptionService = createSubscriptionService(request.server.pg);
    const subscription = await subscriptionService.updateSubscription(request.params.id, request.body);

    reply.send({
      success: true,
      data: subscription,
      message: 'Subscription updated successfully',
    });
  } catch (error) {
    if (error instanceof SubscriptionNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof InvalidSubscriptionDataError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, subscriptionId: request.params.id }, 'Failed to update subscription');
    reply.status(500).send({
      success: false,
      error: 'Failed to update subscription',
    });
  }
}

/**
 * Handle delete subscription request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleDeleteSubscription(
  request: FastifyRequest<{ Params: SubscriptionParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const subscriptionService = createSubscriptionService(request.server.pg);
    const deleted = await subscriptionService.deleteSubscription(request.params.id);

    if (!deleted) {
      reply.status(404).send({
        success: false,
        error: 'Subscription not found',
      });
      return;
    }

    reply.send({
      success: true,
      message: 'Subscription deleted successfully',
    });
  } catch (error) {
    if (error instanceof SubscriptionNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, subscriptionId: request.params.id }, 'Failed to delete subscription');
    reply.status(500).send({
      success: false,
      error: 'Failed to delete subscription',
    });
  }
}

/**
 * Handle renew subscription request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleRenewSubscription(
  request: FastifyRequest<{ Params: SubscriptionParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const subscriptionService = createSubscriptionService(request.server.pg);
    const subscription = await subscriptionService.renewSubscription(request.params.id);

    reply.send({
      success: true,
      data: subscription,
      message: 'Subscription renewed successfully',
    });
  } catch (error) {
    if (error instanceof SubscriptionNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof InvalidSubscriptionDataError) {
      reply.status(400).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, subscriptionId: request.params.id }, 'Failed to renew subscription');
    reply.status(500).send({
      success: false,
      error: 'Failed to renew subscription',
    });
  }
}

/**
 * Handle cancel subscription request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleCancelSubscription(
  request: FastifyRequest<{ Params: SubscriptionParams }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const subscriptionService = createSubscriptionService(request.server.pg);
    const subscription = await subscriptionService.cancelSubscription(request.params.id);

    reply.send({
      success: true,
      data: subscription,
      message: 'Subscription cancelled successfully',
    });
  } catch (error) {
    if (error instanceof SubscriptionNotFoundError) {
      reply.status(404).send({
        success: false,
        error: error.message,
      });
      return;
    }

    logger.error({ error, subscriptionId: request.params.id }, 'Failed to cancel subscription');
    reply.status(500).send({
      success: false,
      error: 'Failed to cancel subscription',
    });
  }
}

/**
 * Handle get expiring subscriptions request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetExpiringSubscriptions(
  request: FastifyRequest<{ Querystring: ExpiringSubscriptionsQuery }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const subscriptionService = createSubscriptionService(request.server.pg);
    const subscriptions = await subscriptionService.getExpiringSubscriptions(request.query);

    reply.send({
      success: true,
      data: subscriptions,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get expiring subscriptions');
    reply.status(500).send({
      success: false,
      error: 'Failed to get expiring subscriptions',
    });
  }
}
