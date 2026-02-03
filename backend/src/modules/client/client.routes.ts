import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticateMiddleware } from '../../middleware/auth.middleware.js';
import { rateLimitMiddleware } from '../../middleware/rate-limit.middleware.js';
import { ClientService } from './client.service.js';
import { createPaymentGatewayService } from '../admin/payment-gateways/index.js';
import { logger } from '../../utils/logger.js';
import { promocodeRoutes } from './promocode.routes.js';
import { subscriptionEnhancedRoutes } from './subscription-enhanced.routes.js';
import { trialRoutes } from './trial.routes.js';
import { clientSubscriptionsAllRoutes } from './subscriptions-all.routes.js';

/**
 * Client API routes for user-facing functionality
 * These endpoints are designed for regular users (not admins)
 */
export async function clientRoutes(fastify: FastifyInstance): Promise<void> {
  const clientService = new ClientService();
  const paymentGatewayService = createPaymentGatewayService(fastify.pg);

  // Apply rate limiting to all client routes
  fastify.addHook('preHandler', rateLimitMiddleware({
    maxRequests: 100,
    windowMs: 60 * 1000, // 1 minute
  }));

  // Apply authentication to all client routes
  fastify.addHook('preHandler', authenticateMiddleware);

  // Register sub-routes
  await fastify.register(promocodeRoutes, { prefix: '/promocode' });
  await fastify.register(subscriptionEnhancedRoutes, { prefix: '/subscriptions/enhanced' });
  await fastify.register(trialRoutes, { prefix: '/trial' });
  await fastify.register(clientSubscriptionsAllRoutes, { prefix: '/subscriptions' });

  /**
   * GET /api/client/me
   * Get current user profile
   */
  fastify.get('/me', {
    schema: {
      description: 'Get current user profile',
      tags: ['client'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                telegramId: { type: 'string' },
                username: { type: 'string' },
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                email: { type: 'string' },
                language: { type: 'string' },
                createdAt: { type: 'string' },
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
        500: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.userId;
        
        if (!userId) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        const user = await clientService.getUserProfile(userId);
        return reply.send({ user });
      } catch (error) {
        logger.error({ error }, 'Failed to get user profile');
        return reply.status(500).send({ error: 'Failed to get user profile' });
      }
    },
  });

  /**
   * GET /api/client/stats
   * Get user statistics (traffic, days left, etc.)
   */
  fastify.get('/stats', {
    schema: {
      description: 'Get user statistics including traffic usage and subscription days left',
      tags: ['client'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            stats: {
              type: 'object',
              properties: {
                totalTraffic: { type: 'number' },
                usedTraffic: { type: 'number' },
                remainingTraffic: { type: 'number' },
                daysLeft: { type: 'number' },
                expiryDate: { type: 'string' },
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
        500: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.userId;
        
        if (!userId) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        const stats = await clientService.getUserStats(userId);
        return reply.send({ stats });
      } catch (error) {
        logger.error({ error }, 'Failed to get user stats');
        return reply.status(500).send({ error: 'Failed to get user stats' });
      }
    },
  });

  /**
   * GET /api/client/subscriptions
   * Get user's subscriptions
   */
  fastify.get('/subscriptions', {
    schema: {
      description: 'Get all subscriptions for the current user',
      tags: ['client'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            subscriptions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  planId: { type: 'number' },
                  planName: { type: 'string' },
                  status: { type: 'string' },
                  expiryDate: { type: 'string' },
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
        500: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.userId;
        
        if (!userId) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        const subscriptions = await clientService.getUserSubscriptions(userId);
        return reply.send({ subscriptions });
      } catch (error) {
        logger.error({ error }, 'Failed to get user subscriptions');
        return reply.status(500).send({ error: 'Failed to get user subscriptions' });
      }
    },
  });

  /**
   * GET /api/client/subscriptions/:id
   * Get subscription details
   */
  fastify.get('/subscriptions/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      const subscriptionId = parseInt(request.params.id, 10);
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      if (isNaN(subscriptionId)) {
        return reply.status(400).send({ error: 'Invalid subscription ID' });
      }

      const subscription = await clientService.getSubscriptionDetails(userId, subscriptionId);
      
      if (!subscription) {
        return reply.status(404).send({ error: 'Subscription not found' });
      }

      return reply.send({ subscription });
    } catch (error) {
      logger.error({ error }, 'Failed to get subscription details');
      return reply.status(500).send({ error: 'Failed to get subscription details' });
    }
  });

  /**
   * POST /api/client/subscriptions/:id/renew
   * Renew a subscription
   */
  fastify.post('/subscriptions/:id/renew', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      const subscriptionId = parseInt(request.params.id, 10);
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      if (isNaN(subscriptionId)) {
        return reply.status(400).send({ error: 'Invalid subscription ID' });
      }

      const result = await clientService.renewSubscription(userId, subscriptionId);
      return reply.send(result);
    } catch (error) {
      logger.error({ error }, 'Failed to renew subscription');
      return reply.status(500).send({ error: 'Failed to renew subscription' });
    }
  });

  /**
   * GET /api/client/subscriptions/:id/qr
   * Get QR code for subscription
   */
  fastify.get('/subscriptions/:id/qr', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      const subscriptionId = parseInt(request.params.id, 10);
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      if (isNaN(subscriptionId)) {
        return reply.status(400).send({ error: 'Invalid subscription ID' });
      }

      const qrData = await clientService.getSubscriptionQR(userId, subscriptionId);
      return reply.send(qrData);
    } catch (error) {
      logger.error({ error }, 'Failed to get subscription QR');
      return reply.status(500).send({ error: 'Failed to get subscription QR' });
    }
  });

  /**
   * GET /api/client/plans
   * Get available plans for purchase
   */
  fastify.get('/plans', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const plans = await clientService.getAvailablePlans(userId);
      return reply.send({ plans });
    } catch (error) {
      logger.error({ error }, 'Failed to get available plans');
      return reply.status(500).send({ error: 'Failed to get available plans' });
    }
  });

  /**
   * POST /api/client/payment/create
   * Create a payment for plan purchase
   */
  fastify.post('/payment/create', {
    schema: {
      description: 'Create a new payment for plan purchase',
      tags: ['client'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['planId', 'durationId', 'gatewayId'],
        properties: {
          planId: { type: 'number', description: 'ID of the plan to purchase' },
          durationId: { type: 'number', description: 'ID of the duration option' },
          gatewayId: { type: 'number', description: 'ID of the payment gateway' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            payment: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                amount: { type: 'number' },
                currency: { type: 'string' },
                status: { type: 'string' },
                paymentUrl: { type: 'string' },
                expiresAt: { type: 'string' },
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
        500: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    handler: async (request: FastifyRequest<{ Body: { planId: number; durationId: number; gatewayId: number } }>, reply: FastifyReply) => {
      try {
        const userId = request.user?.userId;
        
        if (!userId) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        const { planId, durationId, gatewayId } = request.body;

        if (!planId || !durationId || !gatewayId) {
          return reply.status(400).send({ error: 'Missing required fields' });
        }

        const payment = await clientService.createPayment(userId, { planId, durationId, gatewayId });
        return reply.send({ payment });
      } catch (error) {
        logger.error({ error }, 'Failed to create payment');
        return reply.status(500).send({ error: 'Failed to create payment' });
      }
    },
  });

  /**
   * GET /api/client/payment/history
   * Get payment history
   */
  fastify.get('/payment/history', async (request: FastifyRequest<{ Querystring: { page?: number; limit?: number } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const page = request.query.page || 1;
      const limit = request.query.limit || 10;

      const history = await clientService.getPaymentHistory(userId, { page, limit });
      return reply.send(history);
    } catch (error) {
      logger.error({ error }, 'Failed to get payment history');
      return reply.status(500).send({ error: 'Failed to get payment history' });
    }
  });

  /**
   * GET /api/client/payment-gateways
   * Get active payment gateways for client
   */
  fastify.get('/payment-gateways', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const gateways = await paymentGatewayService.getActiveGateways();
      
      // Return simplified gateway info for client
      const simplifiedGateways = gateways.map(gateway => ({
        id: gateway.id,
        name: gateway.name,
        displayName: gateway.displayName,
        sortOrder: gateway.sortOrder,
        supportedCurrencies: gateway.supportedCurrencies,
        icon: gateway.icon,
      }));

      return reply.send({ gateways: simplifiedGateways });
    } catch (error) {
      logger.error({ error }, 'Failed to get payment gateways');
      return reply.status(500).send({ error: 'Failed to get payment gateways' });
    }
  });

  /**
   * GET /api/client/referrals
   * Get user's referrals
   */
  fastify.get('/referrals', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const referrals = await clientService.getUserReferrals(userId);
      return reply.send({ referrals });
    } catch (error) {
      logger.error({ error }, 'Failed to get referrals');
      return reply.status(500).send({ error: 'Failed to get referrals' });
    }
  });

  /**
   * GET /api/client/referrals/stats
   * Get referral statistics
   */
  fastify.get('/referrals/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const stats = await clientService.getReferralStats(userId);
      return reply.send({ stats });
    } catch (error) {
      logger.error({ error }, 'Failed to get referral stats');
      return reply.status(500).send({ error: 'Failed to get referral stats' });
    }
  });

  /**
   * POST /api/client/referrals/withdraw
   * Withdraw referral points
   */
  fastify.post('/referrals/withdraw', async (request: FastifyRequest<{ Body: { amount: number } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { amount } = request.body;

      if (!amount || amount <= 0) {
        return reply.status(400).send({ error: 'Invalid amount' });
      }

      const result = await clientService.withdrawReferralPoints(userId, amount);
      return reply.send(result);
    } catch (error) {
      logger.error({ error }, 'Failed to withdraw referral points');
      return reply.status(500).send({ error: 'Failed to withdraw referral points' });
    }
  });

  /**
   * GET /api/client/partner
   * Get partner dashboard data
   */
  fastify.get('/partner', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const partnerData = await clientService.getPartnerData(userId);
      return reply.send({ partner: partnerData });
    } catch (error) {
      logger.error({ error }, 'Failed to get partner data');
      return reply.status(500).send({ error: 'Failed to get partner data' });
    }
  });

  /**
   * POST /api/client/partner/payout
   * Request partner payout
   */
  fastify.post('/partner/payout', async (request: FastifyRequest<{ Body: { amount: number; method: string; requisites: string } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { amount, method, requisites } = request.body;

      if (!amount || !method || !requisites) {
        return reply.status(400).send({ error: 'Missing required fields' });
      }

      const result = await clientService.requestPayout(userId, { amount, method, requisites });
      return reply.send(result);
    } catch (error) {
      logger.error({ error }, 'Failed to request payout');
      return reply.status(500).send({ error: 'Failed to request payout' });
    }
  });

  /**
   * GET /api/client/notifications
   * Get user notifications
   */
  fastify.get('/notifications', async (request: FastifyRequest<{ Querystring: { page?: number; limit?: number; unreadOnly?: boolean } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const page = request.query.page || 1;
      const limit = request.query.limit || 10;
      const unreadOnly = request.query.unreadOnly || false;

      const notifications = await clientService.getNotifications(userId, { page, limit, unreadOnly });
      return reply.send(notifications);
    } catch (error) {
      logger.error({ error }, 'Failed to get notifications');
      return reply.status(500).send({ error: 'Failed to get notifications' });
    }
  });

  /**
   * PATCH /api/client/notifications/:id/read
   * Mark notification as read
   */
  fastify.patch('/notifications/:id/read', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      const notificationId = parseInt(request.params.id, 10);
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      if (isNaN(notificationId)) {
        return reply.status(400).send({ error: 'Invalid notification ID' });
      }

      const result = await clientService.markNotificationAsRead(userId, notificationId);
      return reply.send(result);
    } catch (error) {
      logger.error({ error }, 'Failed to mark notification as read');
      return reply.status(500).send({ error: 'Failed to mark notification as read' });
    }
  });

  // ============================================================================
  // REFERRAL SYSTEM - DETAILED ENDPOINTS
  // ============================================================================

  /**
   * GET /api/client/referrals/full-info
   * Get full referral information with levels
   */
  fastify.get('/referrals/full-info', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const info = await clientService.getFullReferralInfo(userId);
      return reply.send({ info });
    } catch (error) {
      logger.error({ error }, 'Failed to get full referral info');
      return reply.status(500).send({ error: 'Failed to get full referral info' });
    }
  });

  /**
   * GET /api/client/referrals/rules
   * Get referral rules
   */
  fastify.get('/referrals/rules', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const rules = await clientService.getReferralRules();
      return reply.send({ rules });
    } catch (error) {
      logger.error({ error }, 'Failed to get referral rules');
      return reply.status(500).send({ error: 'Failed to get referral rules' });
    }
  });

  /**
   * GET /api/client/referrals/history
   * Get referral earnings history
   */
  fastify.get('/referrals/history', async (request: FastifyRequest<{ Querystring: { page?: number; limit?: number } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const page = request.query.page || 1;
      const limit = request.query.limit || 10;

      const history = await clientService.getReferralHistory(userId, { page, limit });
      return reply.send(history);
    } catch (error) {
      logger.error({ error }, 'Failed to get referral history');
      return reply.status(500).send({ error: 'Failed to get referral history' });
    }
  });

  /**
   * GET /api/client/referrals/levels
   * Get referral levels statistics
   */
  fastify.get('/referrals/levels', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const levels = await clientService.getReferralLevels(userId);
      return reply.send({ levels });
    } catch (error) {
      logger.error({ error }, 'Failed to get referral levels');
      return reply.status(500).send({ error: 'Failed to get referral levels' });
    }
  });

  /**
   * GET /api/client/referrals/top
   * Get top referrers
   */
  fastify.get('/referrals/top', async (request: FastifyRequest<{ Querystring: { limit?: number } }>, reply: FastifyReply) => {
    try {
      const limit = request.query.limit || 10;
      const top = await clientService.getTopReferrers(limit);
      return reply.send({ top });
    } catch (error) {
      logger.error({ error }, 'Failed to get top referrers');
      return reply.status(500).send({ error: 'Failed to get top referrers' });
    }
  });

  /**
   * POST /api/client/referrals/exchange-points
   * Exchange points for rewards
   */
  fastify.post('/referrals/exchange-points', async (request: FastifyRequest<{ Body: { type: string; amount: number } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { type, amount } = request.body;

      if (!type || !amount || amount <= 0) {
        return reply.status(400).send({ error: 'Invalid exchange parameters' });
      }

      const result = await clientService.exchangePoints(userId, type, amount);
      return reply.send(result);
    } catch (error) {
      logger.error({ error }, 'Failed to exchange points');
      return reply.status(500).send({ error: 'Failed to exchange points' });
    }
  });

  // ============================================================================
  // PARTNER SYSTEM - DETAILED ENDPOINTS
  // ============================================================================

  /**
   * GET /api/client/partner/full-stats
   * Get full partner statistics
   */
  fastify.get('/partner/full-stats', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const stats = await clientService.getFullPartnerStats(userId);
      return reply.send({ stats });
    } catch (error) {
      logger.error({ error }, 'Failed to get full partner stats');
      return reply.status(500).send({ error: 'Failed to get full partner stats' });
    }
  });

  /**
   * GET /api/client/partner/earnings-history
   * Get partner earnings history
   */
  fastify.get('/partner/earnings-history', async (request: FastifyRequest<{ Querystring: { page?: number; limit?: number } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const page = request.query.page || 1;
      const limit = request.query.limit || 10;

      const history = await clientService.getPartnerEarningsHistory(userId, { page, limit });
      return reply.send(history);
    } catch (error) {
      logger.error({ error }, 'Failed to get partner earnings history');
      return reply.status(500).send({ error: 'Failed to get partner earnings history' });
    }
  });

  /**
   * GET /api/client/partner/payouts-history
   * Get partner payouts history
   */
  fastify.get('/partner/payouts-history', async (request: FastifyRequest<{ Querystring: { page?: number; limit?: number } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const page = request.query.page || 1;
      const limit = request.query.limit || 10;

      const history = await clientService.getPartnerPayoutsHistory(userId, { page, limit });
      return reply.send(history);
    } catch (error) {
      logger.error({ error }, 'Failed to get partner payouts history');
      return reply.status(500).send({ error: 'Failed to get partner payouts history' });
    }
  });

  /**
   * GET /api/client/partner/referral/:id
   * Get partner referral details
   */
  fastify.get('/partner/referral/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      const referralId = request.params.id;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const details = await clientService.getPartnerReferralDetails(userId, referralId);
      return reply.send({ details });
    } catch (error) {
      logger.error({ error }, 'Failed to get partner referral details');
      return reply.status(500).send({ error: 'Failed to get partner referral details' });
    }
  });

  /**
   * GET /api/client/partner/referrals-by-level
   * Get referrals grouped by level
   */
  fastify.get('/partner/referrals-by-level', async (request: FastifyRequest<{ Querystring: { level?: number } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const level = request.query.level;
      const referrals = await clientService.getReferralsByLevel(userId, level);
      return reply.send({ referrals });
    } catch (error) {
      logger.error({ error }, 'Failed to get referrals by level');
      return reply.status(500).send({ error: 'Failed to get referrals by level' });
    }
  });

  /**
   * GET /api/client/partner/conversion-stats
   * Get partner conversion statistics
   */
  fastify.get('/partner/conversion-stats', async (request: FastifyRequest<{ Querystring: { days?: number } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const days = request.query.days || 30;
      const stats = await clientService.getConversionStats(userId, days);
      return reply.send({ stats });
    } catch (error) {
      logger.error({ error }, 'Failed to get conversion stats');
      return reply.status(500).send({ error: 'Failed to get conversion stats' });
    }
  });

  // ============================================================================
  // LANGUAGE & TRANSLATION ENDPOINTS
  // ============================================================================

  /**
   * GET /api/client/language
   * Get current user language
   */
  fastify.get('/language', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const language = await clientService.getUserLanguage(userId);
      return reply.send({ language });
    } catch (error) {
      logger.error({ error }, 'Failed to get user language');
      return reply.status(500).send({ error: 'Failed to get user language' });
    }
  });

  /**
   * PUT /api/client/language
   * Update user language
   */
  fastify.put('/language', async (request: FastifyRequest<{ Body: { language: string } }>, reply: FastifyReply) => {
    try {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { language } = request.body;

      if (!language || !['ru', 'en'].includes(language)) {
        return reply.status(400).send({ error: 'Invalid language. Must be "ru" or "en"' });
      }

      const result = await clientService.updateUserLanguage(userId, language);
      return reply.send(result);
    } catch (error) {
      logger.error({ error }, 'Failed to update user language');
      return reply.status(500).send({ error: 'Failed to update user language' });
    }
  });

  /**
   * GET /api/client/translations
   * Get all translations for a language
   */
  fastify.get('/translations', async (request: FastifyRequest<{ Querystring: { lang?: string } }>, reply: FastifyReply) => {
    try {
      const lang = request.query.lang || 'ru';
      
      if (!['ru', 'en'].includes(lang)) {
        return reply.status(400).send({ error: 'Invalid language' });
      }

      const translations = await clientService.getTranslations(lang);
      return reply.send({ translations });
    } catch (error) {
      logger.error({ error }, 'Failed to get translations');
      return reply.status(500).send({ error: 'Failed to get translations' });
    }
  });
}
