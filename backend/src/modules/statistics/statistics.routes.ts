import type { FastifyInstance } from 'fastify';
import {
  handleGetDashboardStats,
  handleGetRevenueStats,
  handleGetUserStats,
  handleGetSubscriptionStats,
  handleGetDailyStatistics,
} from './statistics.controller.js';

/**
 * Register statistics routes
 * @param fastify - Fastify instance
 */
export async function statisticsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /statistics/dashboard
   * Get dashboard statistics
   */
  fastify.get('/dashboard', {
    schema: {
      description: 'Get dashboard statistics',
      tags: ['statistics'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                totalRevenue: { type: 'number' },
                newUsersToday: { type: 'number' },
                newSubscriptionsToday: { type: 'number' },
                activeUsersToday: { type: 'number' },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleGetDashboardStats,
  });

  /**
   * GET /statistics/revenue
   * Get revenue statistics
   */
  fastify.get('/revenue', {
    schema: {
      description: 'Get revenue statistics',
      tags: ['statistics'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          startDate: { type: 'string', format: 'date-time' },
          endDate: { type: 'string', format: 'date-time' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                totalRevenue: { type: 'number' },
                periodRevenue: { type: 'number' },
                averageDailyRevenue: { type: 'number' },
                growthRate: { type: 'number' },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleGetRevenueStats,
  });

  /**
   * GET /statistics/users
   * Get user statistics
   */
  fastify.get('/users', {
    schema: {
      description: 'Get user statistics',
      tags: ['statistics'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                totalUsers: { type: 'number' },
                activeUsers: { type: 'number' },
                blockedUsers: { type: 'number' },
                newUsersThisMonth: { type: 'number' },
                growthRate: { type: 'number' },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleGetUserStats,
  });

  /**
   * GET /statistics/subscriptions
   * Get subscription statistics
   */
  fastify.get('/subscriptions', {
    schema: {
      description: 'Get subscription statistics',
      tags: ['statistics'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                totalSubscriptions: { type: 'number' },
                activeSubscriptions: { type: 'number' },
                expiredSubscriptions: { type: 'number' },
                cancelledSubscriptions: { type: 'number' },
                expiringSoon: { type: 'number' },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleGetSubscriptionStats,
  });

  /**
   * GET /statistics/daily
   * Get daily statistics
   */
  fastify.get('/daily', {
    schema: {
      description: 'Get daily statistics',
      tags: ['statistics'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          startDate: { type: 'string', format: 'date-time' },
          endDate: { type: 'string', format: 'date-time' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  date: { type: 'string' },
                  newUsers: { type: 'number' },
                  activeUsers: { type: 'number' },
                  newSubscriptions: { type: 'number' },
                  revenue: { type: 'number' },
                  createdAt: { type: 'string' },
                },
              },
            },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleGetDailyStatistics,
  });
}
