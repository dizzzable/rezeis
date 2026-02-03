import type { FastifyRequest, FastifyReply } from 'fastify';
import { createStatisticsService } from './statistics.service.js';
import { logger } from '../../utils/logger.js';
import type { DateRangeQuery } from './statistics.schemas.js';

/**
 * Handle get dashboard stats request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetDashboardStats(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const statisticsService = createStatisticsService(request.server.pg);
    const stats = await statisticsService.getDashboardStats();

    reply.send({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get dashboard stats');
    reply.status(500).send({
      success: false,
      error: 'Failed to get dashboard stats',
    });
  }
}

/**
 * Handle get revenue stats request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetRevenueStats(
  request: FastifyRequest<{ Querystring: DateRangeQuery }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const statisticsService = createStatisticsService(request.server.pg);
    const stats = await statisticsService.getRevenueStats(request.query);

    reply.send({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get revenue stats');
    reply.status(500).send({
      success: false,
      error: 'Failed to get revenue stats',
    });
  }
}

/**
 * Handle get user stats request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetUserStats(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const statisticsService = createStatisticsService(request.server.pg);
    const stats = await statisticsService.getUserStats();

    reply.send({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get user stats');
    reply.status(500).send({
      success: false,
      error: 'Failed to get user stats',
    });
  }
}

/**
 * Handle get subscription stats request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetSubscriptionStats(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const statisticsService = createStatisticsService(request.server.pg);
    const stats = await statisticsService.getSubscriptionStats();

    reply.send({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get subscription stats');
    reply.status(500).send({
      success: false,
      error: 'Failed to get subscription stats',
    });
  }
}

/**
 * Handle get daily statistics request
 * @param request - Fastify request
 * @param reply - Fastify reply
 */
export async function handleGetDailyStatistics(
  request: FastifyRequest<{ Querystring: DateRangeQuery }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const statisticsService = createStatisticsService(request.server.pg);
    const stats = await statisticsService.getDailyStatistics(request.query);

    reply.send({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get daily statistics');
    reply.status(500).send({
      success: false,
      error: 'Failed to get daily statistics',
    });
  }
}
