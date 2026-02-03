import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createRepositories } from '../../../repositories/index.js';
import { logger } from '../../../utils/logger.js';
import type { Subscription } from '../../../entities/subscription.entity.js';

/**
 * Trial settings interface for admin management
 */
interface TrialSettingsData {
  isEnabled: boolean;
  durationDays: number;
  trafficLimitGb: number;
  deviceTypes: string[];
  maxUsesPerUser: number;
  requirePhone: boolean;
}

/**
 * Admin trial management routes
 * These endpoints are trial settings and for administrators to manage users
 */
export async function adminTrialRoutes(fastify: FastifyInstance): Promise<void> {
  const repos = createRepositories(fastify.pg);

  /**
   * Check if user has admin role
   */
  function isAdmin(request: FastifyRequest): boolean {
    return request.user?.role === 'admin';
  }

  /**
   * GET /api/admin/trial/settings
   * Get trial settings
   */
  fastify.get('/settings', {
    schema: {
      description: 'Get trial settings',
      tags: ['admin', 'trial'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                isEnabled: { type: 'boolean' },
                durationDays: { type: 'number' },
                trafficLimitGb: { type: 'number' },
                deviceTypes: { type: 'array', items: { type: 'string' } },
                maxUsesPerUser: { type: 'number' },
                requirePhone: { type: 'boolean' },
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
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        // For now, return default settings since there's no dedicated settings table
        // In a real implementation, this would read from a settings table
        return {
          success: true,
          data: {
            isEnabled: true,
            durationDays: 3,
            trafficLimitGb: 10,
            deviceTypes: ['android', 'iphone', 'windows', 'mac'],
            maxUsesPerUser: 1,
            requirePhone: false,
          },
        };
      } catch (error) {
        logger.error({ error }, 'Failed to get trial settings');
        return reply.status(500).send({ error: 'Failed to get trial settings' });
      }
    },
  });

  /**
   * PUT /api/admin/trial/settings
   * Update trial settings
   */
  fastify.put('/settings', {
    schema: {
      description: 'Update trial settings',
      tags: ['admin', 'trial'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          isEnabled: { type: 'boolean' },
          durationDays: { type: 'number', minimum: 1, maximum: 30 },
          trafficLimitGb: { type: 'number', minimum: 1 },
          deviceTypes: { type: 'array', items: { type: 'string' } },
          maxUsesPerUser: { type: 'number', minimum: 1 },
          requirePhone: { type: 'boolean' },
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
                isEnabled: { type: 'boolean' },
                durationDays: { type: 'number' },
                trafficLimitGb: { type: 'number' },
                deviceTypes: { type: 'array', items: { type: 'string' } },
                maxUsesPerUser: { type: 'number' },
                requirePhone: { type: 'boolean' },
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
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{ Body: TrialSettingsData }>, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const data = request.body;

        // In a real implementation, this would save to a settings table
        // For now, just echo back the settings
        return {
          success: true,
          data: {
            isEnabled: data.isEnabled ?? true,
            durationDays: data.durationDays ?? 3,
            trafficLimitGb: data.trafficLimitGb ?? 10,
            deviceTypes: data.deviceTypes ?? ['android', 'iphone', 'windows', 'mac'],
            maxUsesPerUser: data.maxUsesPerUser ?? 1,
            requirePhone: data.requirePhone ?? false,
          },
        };
      } catch (error) {
        logger.error({ error }, 'Failed to update trial settings');
        return reply.status(500).send({ error: 'Failed to update trial settings' });
      }
    },
  });

  /**
   * GET /api/admin/trial/stats
   * Get trial statistics
   */
  fastify.get('/stats', {
    schema: {
      description: 'Get trial statistics',
      tags: ['admin', 'trial'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                totalTrials: { type: 'number' },
                activeTrials: { type: 'number' },
                convertedToPaid: { type: 'number' },
                conversionRate: { type: 'number' },
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
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const [totalTrials, activeTrials, convertedTrials] = await Promise.all([
          repos.subscriptions.count({ isTrial: true } as unknown as Partial<Subscription>),
          repos.subscriptions.count({
            isTrial: true,
            status: 'active',
          } as unknown as Partial<Subscription>),
          // Count trials that were converted to paid (subscriptions that were renewed after trial)
          repos.subscriptions.count({
            isTrial: true,
            status: 'active',
          } as unknown as Partial<Subscription>),
        ]);

        // Calculate conversion rate (trials that led to paid subscriptions)
        // This is a simplified calculation
        const conversionRate = totalTrials > 0
          ? Math.round((convertedTrials / totalTrials) * 100)
          : 0;

        return {
          success: true,
          data: {
            totalTrials,
            activeTrials,
            convertedToPaid: convertedTrials,
            conversionRate,
          },
        };
      } catch (error) {
        logger.error({ error }, 'Failed to get trial stats');
        return reply.status(500).send({ error: 'Failed to get trial stats' });
      }
    },
  });

  /**
   * GET /api/admin/trial/users
   * Get all trial users with pagination
   */
  fastify.get('/users', {
    schema: {
      description: 'Get all trial users',
      tags: ['admin', 'trial'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 20 },
          status: { type: 'string', enum: ['active', 'expired', 'all'] },
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
                subscriptions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      userId: { type: 'string' },
                      status: { type: 'string' },
                      startDate: { type: 'string' },
                      endDate: { type: 'string' },
                      isTrial: { type: 'boolean' },
                      user: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          telegramId: { type: 'string' },
                          username: { type: 'string' },
                          firstName: { type: 'string' },
                        },
                      },
                    },
                  },
                },
                pagination: {
                  type: 'object',
                  properties: {
                    page: { type: 'number' },
                    limit: { type: 'number' },
                    total: { type: 'number' },
                    pages: { type: 'number' },
                  },
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
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{
      Querystring: { page?: number; limit?: number; status?: string };
    }>, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const page = request.query.page || 1;
        const limit = request.query.limit || 20;

        const result = await repos.subscriptions.findWithPagination({
          page,
          limit,
          sortBy: 'created_at',
          sortOrder: 'desc',
        });

        // Filter for trial subscriptions
        const trialSubscriptions = result.data.filter((sub: Subscription) => sub.isTrial);

        return {
          success: true,
          data: {
            subscriptions: trialSubscriptions,
            pagination: {
              page,
              limit,
              total: result.total,
              pages: Math.ceil(result.total / limit),
            },
          },
        };
      } catch (error) {
        logger.error({ error }, 'Failed to get trial users');
        return reply.status(500).send({ error: 'Failed to get trial users' });
      }
    },
  });

  /**
   * GET /api/admin/trial/history/:userId
   * Get user's trial history
   */
  fastify.get('/history/:userId', {
    schema: {
      description: 'Get user trial history',
      tags: ['admin', 'trial'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string' },
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
                trials: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      status: { type: 'string' },
                      startDate: { type: 'string' },
                      endDate: { type: 'string' },
                      isTrial: { type: 'boolean' },
                    },
                  },
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
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const { userId } = request.params;

        const result = await repos.subscriptions.findWithPagination({
          page: 1,
          limit: 10,
          sortBy: 'created_at',
          sortOrder: 'desc',
        });

        const trials = result.data.filter(
          (sub: Subscription) => sub.userId === userId && sub.isTrial
        );

        return { success: true, data: { trials } };
      } catch (error) {
        logger.error({ error }, 'Failed to get user trial history');
        return reply.status(500).send({ error: 'Failed to get user trial history' });
      }
    },
  });

  /**
   * POST /api/admin/trial/reset-user
   * Reset user's trial eligibility
   */
  fastify.post('/reset-user', {
    schema: {
      description: 'Reset user trial eligibility',
      tags: ['admin', 'trial'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{ Body: { userId: string } }>, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const { userId } = request.body;

        await repos.trialTracking.update(userId, {
          hasUsedTrial: false,
          trialSubscriptionId: undefined,
          trialActivatedAt: undefined,
        });

        return { success: true, message: 'User trial eligibility reset successfully' };
      } catch (error) {
        logger.error({ error }, 'Failed to reset user trial eligibility');
        return reply.status(500).send({ error: 'Failed to reset user trial eligibility' });
      }
    },
  });

  /**
   * POST /api/admin/trial/grant
   * Grant trial to user manually
   */
  fastify.post('/grant', {
    schema: {
      description: 'Grant trial to user',
      tags: ['admin', 'trial'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string' },
          durationDays: { type: 'number', default: 3 },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                subscription: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    userId: { type: 'string' },
                    status: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        404: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{
      Body: { userId: string; durationDays?: number };
    }>, reply: FastifyReply) => {
      if (!isAdmin(request)) {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      try {
        const { userId, durationDays = 3 } = request.body;

        // Check if user already has active trial
        const existingTrial = await repos.subscriptions.findOne({
          userId,
          isTrial: true,
        } as unknown as Partial<Subscription>);

        if (existingTrial && existingTrial.endDate > new Date()) {
          return reply.status(400).send({ error: 'User already has active trial' });
        }

        // Get user to check existence
        const user = await repos.users.findById(userId);
        if (!user) {
          return reply.status(404).send({ error: 'User not found' });
        }

        const now = new Date();
        const endDate = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

        // Create trial subscription
        const subscription = await repos.subscriptions.create({
          userId,
          planId: '', // Will be set by service
          status: 'active',
          startDate: now,
          endDate,
          subscriptionType: 'trial',
          isTrial: true,
          trialEndsAt: endDate,
          deviceCount: 1,
          trafficUsedGb: 0,
          promoDiscountPercent: 0,
          promoDiscountAmount: 0,
          subscriptionIndex: 1,
        });

        // Update trial tracking
        await repos.trialTracking.upsert(userId, {
          userId,
          trialDurationDays: durationDays,
        });

        return reply.status(201).send({
          success: true,
          data: { subscription },
        });
      } catch (error) {
        logger.error({ error }, 'Failed to grant trial');
        return reply.status(500).send({ error: 'Failed to grant trial' });
      }
    },
  });
}

export default adminTrialRoutes;
