import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { partnerService } from '../../partner/partner.service.js';
import { logger } from '../../../utils/logger.js';

/**
 * Client partner routes
 * These endpoints are for partners to view their stats and manage payouts
 */
export async function clientPartnerRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/client/partner/status
   * Check if user is a partner and get basic status
   */
  fastify.get('/status', {
    schema: {
      description: 'Get partner status for current user',
      tags: ['client', 'partner'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                isPartner: { type: 'boolean' },
                canRequest: { type: 'boolean' },
                activatedAt: { type: 'string' },
                notes: { type: 'string' },
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
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.userId;

        if (!userId) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        const isPartner = await partnerService.isPartner(userId);
        const settings = await partnerService.getSettings();

        // Get activation info if partner
        let activatedAt = null;
        let notes = null;
        if (isPartner) {
          const pool = fastify.pg;
          const result = await pool.query(
            `SELECT partner_activated_at, partner_notes FROM users WHERE id = $1`,
            [userId]
          );
          if (result.rows.length > 0) {
            activatedAt = result.rows[0].partner_activated_at;
            notes = result.rows[0].partner_notes;
          }
        }

        return reply.send({
          success: true,
          data: {
            isPartner,
            canRequest: settings.isEnabled,
            activatedAt,
            notes,
          },
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get partner status');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get partner status',
        });
      }
    },
  });

  /**
   * GET /api/client/partner/stats
   * Get partner statistics
   */
  fastify.get('/stats', {
    schema: {
      description: 'Get partner statistics',
      tags: ['client', 'partner'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                userId: { type: 'string' },
                totalEarnings: { type: 'number' },
                pendingEarnings: { type: 'number' },
                paidEarnings: { type: 'number' },
                referralCount: { type: 'number' },
                activeReferrals: { type: 'number' },
                conversionRate: { type: 'number' },
                totalClicks: { type: 'number' },
                totalConversions: { type: 'number' },
              },
            },
          },
        },
        403: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
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
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = request.user?.userId;

        if (!userId) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        // Check if user is partner
        const isPartner = await partnerService.isPartner(userId);
        if (!isPartner) {
          return reply.status(403).send({
            success: false,
            error: 'Partner access required',
          });
        }

        const stats = await partnerService.getPartnerStats(userId);

        return reply.send({ success: true, data: stats });
      } catch (error) {
        logger.error({ error }, 'Failed to get partner stats');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get partner stats',
        });
      }
    },
  });

  /**
   * GET /api/client/partner/referrals
   * Get partner referrals
   */
  fastify.get('/referrals', {
    schema: {
      description: 'Get partner referrals',
      tags: ['client', 'partner'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 20 },
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
                items: { type: 'array' },
                total: { type: 'number' },
                page: { type: 'number' },
                limit: { type: 'number' },
              },
            },
          },
        },
        403: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{ Querystring: { page?: number; limit?: number } }>, reply: FastifyReply) => {
      try {
        const userId = request.user?.userId;

        if (!userId) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        const isPartner = await partnerService.isPartner(userId);
        if (!isPartner) {
          return reply.status(403).send({
            success: false,
            error: 'Partner access required',
          });
        }

        const page = request.query.page || 1;
        const limit = request.query.limit || 20;
        const offset = (page - 1) * limit;

        const pool = fastify.pg;
        const [itemsResult, countResult] = await Promise.all([
          pool.query(
            `SELECT 
              r.*,
              u.username as referred_username,
              u.first_name as referred_first_name,
              u.photo_url as referred_photo_url
             FROM referrals r
             LEFT JOIN users u ON r.referred_id = u.id
             WHERE r.referrer_id = $1
             ORDER BY r.created_at DESC
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
          ),
          pool.query(
            `SELECT COUNT(*) as total FROM referrals WHERE referrer_id = $1`,
            [userId]
          ),
        ]);

        return reply.send({
          success: true,
          data: {
            items: itemsResult.rows,
            total: parseInt(countResult.rows[0].total, 10),
            page,
            limit,
          },
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get partner referrals');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get partner referrals',
        });
      }
    },
  });

  /**
   * GET /api/client/partner/earnings
   * Get partner earnings history
   */
  fastify.get('/earnings', {
    schema: {
      description: 'Get partner earnings history',
      tags: ['client', 'partner'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 20 },
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
                items: { type: 'array' },
                total: { type: 'number' },
                page: { type: 'number' },
                limit: { type: 'number' },
              },
            },
          },
        },
        403: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{ Querystring: { page?: number; limit?: number } }>, reply: FastifyReply) => {
      try {
        const userId = request.user?.userId;

        if (!userId) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        const isPartner = await partnerService.isPartner(userId);
        if (!isPartner) {
          return reply.status(403).send({
            success: false,
            error: 'Partner access required',
          });
        }

        const page = request.query.page || 1;
        const limit = request.query.limit || 20;
        const offset = (page - 1) * limit;

        const pool = fastify.pg;
        const partnerResult = await pool.query(
          `SELECT id FROM partners WHERE user_id = $1`,
          [userId]
        );

        if (partnerResult.rows.length === 0) {
          return reply.send({
            success: true,
            data: { items: [], total: 0, page, limit },
          });
        }

        const partnerId = partnerResult.rows[0].id;

        const [itemsResult, countResult] = await Promise.all([
          pool.query(
            `SELECT 
              pce.*,
              u.username as from_username,
              u.first_name as from_first_name
             FROM partner_commission_earnings pce
             LEFT JOIN users u ON pce.from_user_id = u.id
             WHERE pce.partner_id = $1
             ORDER BY pce.created_at DESC
             LIMIT $2 OFFSET $3`,
            [partnerId, limit, offset]
          ),
          pool.query(
            `SELECT COUNT(*) as total FROM partner_commission_earnings WHERE partner_id = $1`,
            [partnerId]
          ),
        ]);

        return reply.send({
          success: true,
          data: {
            items: itemsResult.rows,
            total: parseInt(countResult.rows[0].total, 10),
            page,
            limit,
          },
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get partner earnings');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get partner earnings',
        });
      }
    },
  });

  /**
   * GET /api/client/partner/payouts
   * Get partner payout history
   */
  fastify.get('/payouts', {
    schema: {
      description: 'Get partner payout history',
      tags: ['client', 'partner'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 20 },
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
                items: { type: 'array' },
                total: { type: 'number' },
                page: { type: 'number' },
                limit: { type: 'number' },
              },
            },
          },
        },
        403: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{ Querystring: { page?: number; limit?: number } }>, reply: FastifyReply) => {
      try {
        const userId = request.user?.userId;

        if (!userId) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        const isPartner = await partnerService.isPartner(userId);
        if (!isPartner) {
          return reply.status(403).send({
            success: false,
            error: 'Partner access required',
          });
        }

        const page = request.query.page || 1;
        const limit = request.query.limit || 20;
        const offset = (page - 1) * limit;

        const pool = fastify.pg;
        const partnerResult = await pool.query(
          `SELECT id FROM partners WHERE user_id = $1`,
          [userId]
        );

        if (partnerResult.rows.length === 0) {
          return reply.send({
            success: true,
            data: { items: [], total: 0, page, limit },
          });
        }

        const partnerId = partnerResult.rows[0].id;

        const [itemsResult, countResult] = await Promise.all([
          pool.query(
            `SELECT 
              id,
              amount,
              status,
              payment_method,
              notes,
              processed_at,
              created_at
             FROM partner_payouts
             WHERE partner_id = $1
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [partnerId, limit, offset]
          ),
          pool.query(
            `SELECT COUNT(*) as total FROM partner_payouts WHERE partner_id = $1`,
            [partnerId]
          ),
        ]);

        return reply.send({
          success: true,
          data: {
            items: itemsResult.rows,
            total: parseInt(countResult.rows[0].total, 10),
            page,
            limit,
          },
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get partner payouts');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get partner payouts',
        });
      }
    },
  });

  /**
   * POST /api/client/partner/payouts
   * Create a payout request
   */
  fastify.post('/payouts', {
    schema: {
      description: 'Create payout request',
      tags: ['client', 'partner'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['amount', 'paymentMethod', 'paymentDetails'],
        properties: {
          amount: { type: 'number', minimum: 0.01 },
          paymentMethod: { type: 'string' },
          paymentDetails: { type: 'object' },
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
                id: { type: 'string' },
                amount: { type: 'number' },
                status: { type: 'string' },
                createdAt: { type: 'string' },
              },
            },
            message: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{ Body: {
      amount: number;
      paymentMethod: string;
      paymentDetails: Record<string, unknown>;
    } }>, reply: FastifyReply) => {
      try {
        const userId = request.user?.userId;

        if (!userId) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        const isPartner = await partnerService.isPartner(userId);
        if (!isPartner) {
          return reply.status(403).send({
            success: false,
            error: 'Partner access required',
          });
        }

        const pool = fastify.pg;
        const partnerResult = await pool.query(
          `SELECT id FROM partners WHERE user_id = $1`,
          [userId]
        );

        if (partnerResult.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: 'Partner not found',
          });
        }

        const partnerId = partnerResult.rows[0].id;

        const result = await partnerService.requestPayout(
          partnerId,
          request.body.amount,
          request.body.paymentMethod,
          request.body.paymentDetails
        );

        return reply.status(201).send({
          success: true,
          data: result,
          message: 'Payout request created successfully',
        });
      } catch (error) {
        logger.error({ error }, 'Failed to create payout request');
        if (error instanceof Error && error.message === 'Insufficient balance') {
          return reply.status(400).send({
            success: false,
            error: 'Insufficient balance',
          });
        }
        if (error instanceof Error && error.message.includes('Minimum payout amount')) {
          return reply.status(400).send({
            success: false,
            error: error.message,
          });
        }
        return reply.status(500).send({
          success: false,
          error: 'Failed to create payout request',
        });
      }
    },
  });

  /**
   * GET /api/client/partner/settings
   * Get partner program settings (public info)
   */
  fastify.get('/settings', {
    schema: {
      description: 'Get partner program settings',
      tags: ['client', 'partner'],
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
                level1Percent: { type: 'number' },
                level2Percent: { type: 'number' },
                level3Percent: { type: 'number' },
                minPayoutAmount: { type: 'number' },
              },
            },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const settings = await partnerService.getSettings();

        return reply.send({
          success: true,
          data: {
            isEnabled: settings.isEnabled,
            level1Percent: settings.level1Percent,
            level2Percent: settings.level2Percent,
            level3Percent: settings.level3Percent,
            minPayoutAmount: settings.minPayoutAmount,
          },
        });
      } catch (error) {
        logger.error({ error }, 'Failed to get partner settings');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get partner settings',
        });
      }
    },
  });
}

export default clientPartnerRoutes;
