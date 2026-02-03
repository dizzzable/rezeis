import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { partnerService } from '../../partner/partner.service.js';
import { logger } from '../../../utils/logger.js';

/**
 * Admin partner management routes
 * These endpoints are for administrators to manage the hidden partner program
 */
export async function adminPartnerRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/admin/partners
   * Get all partners with pagination and search
   */
  fastify.get('/', {
    schema: {
      description: 'Get all partners',
      tags: ['admin', 'partners'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 20 },
          search: { type: 'string' },
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
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      userId: { type: 'string' },
                      username: { type: 'string' },
                      firstName: { type: 'string' },
                      lastName: { type: 'string' },
                      photoUrl: { type: 'string' },
                      isPartner: { type: 'boolean' },
                      partnerActivatedAt: { type: 'string' },
                      partnerActivatedBy: { type: 'string' },
                      partnerNotes: { type: 'string' },
                      balance: { type: 'number' },
                      totalEarnings: { type: 'number' },
                      referralCount: { type: 'number' },
                      createdAt: { type: 'string' },
                    },
                  },
                },
                total: { type: 'number' },
                page: { type: 'number' },
                limit: { type: 'number' },
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
    handler: async (request: FastifyRequest<{ Querystring: { page?: number; limit?: number; search?: string } }>, reply: FastifyReply) => {
      try {
        // Check admin role
        if (request.user?.role !== 'admin') {
          return reply.status(403).send({
            success: false,
            error: 'Admin access required',
          });
        }

        const result = await partnerService.getAllPartners({
          page: request.query.page,
          limit: request.query.limit,
          search: request.query.search,
        });

        return reply.send({ success: true, data: result });
      } catch (error) {
        logger.error({ error }, 'Failed to get partners');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get partners',
        });
      }
    },
  });

  /**
   * POST /api/admin/partners/:id/activate
   * Activate partner status for a user
   */
  fastify.post('/:id/activate', {
    schema: {
      description: 'Activate partner for user',
      tags: ['admin', 'partners'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          notes: { type: 'string' },
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
                id: { type: 'string' },
                userId: { type: 'string' },
                username: { type: 'string' },
                isPartner: { type: 'boolean' },
                partnerActivatedAt: { type: 'string' },
              },
            },
            message: { type: 'string' },
          },
        },
        404: {
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
    handler: async (request: FastifyRequest<{ Params: { id: string }; Body: { notes?: string } }>, reply: FastifyReply) => {
      try {
        if (request.user?.role !== 'admin') {
          return reply.status(403).send({
            success: false,
            error: 'Admin access required',
          });
        }

        const result = await partnerService.activatePartner(
          request.params.id,
          request.user.userId,
          request.body.notes
        );

        return reply.send({
          success: true,
          data: result,
          message: 'Partner activated successfully',
        });
      } catch (error) {
        logger.error({ error, userId: request.params.id }, 'Failed to activate partner');
        if (error instanceof Error && error.message === 'User not found') {
          return reply.status(404).send({
            success: false,
            error: 'User not found',
          });
        }
        if (error instanceof Error && error.message === 'User is already a partner') {
          return reply.status(400).send({
            success: false,
            error: 'User is already a partner',
          });
        }
        return reply.status(500).send({
          success: false,
          error: 'Failed to activate partner',
        });
      }
    },
  });

  /**
   * POST /api/admin/partners/:id/deactivate
   * Deactivate partner status for a user
   */
  fastify.post('/:id/deactivate', {
    schema: {
      description: 'Deactivate partner for user',
      tags: ['admin', 'partners'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
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
                id: { type: 'string' },
                userId: { type: 'string' },
                isPartner: { type: 'boolean' },
              },
            },
            message: { type: 'string' },
          },
        },
        404: {
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
    handler: async (request: FastifyRequest<{ Params: { id: string }; Body: { reason?: string } }>, reply: FastifyReply) => {
      try {
        if (request.user?.role !== 'admin') {
          return reply.status(403).send({
            success: false,
            error: 'Admin access required',
          });
        }

        const result = await partnerService.deactivatePartner(
          request.params.id,
          request.user.userId,
          request.body.reason
        );

        return reply.send({
          success: true,
          data: result,
          message: 'Partner deactivated successfully',
        });
      } catch (error) {
        logger.error({ error, userId: request.params.id }, 'Failed to deactivate partner');
        if (error instanceof Error && error.message === 'User not found') {
          return reply.status(404).send({
            success: false,
            error: 'User not found',
          });
        }
        if (error instanceof Error && error.message === 'User is not a partner') {
          return reply.status(400).send({
            success: false,
            error: 'User is not a partner',
          });
        }
        return reply.status(500).send({
          success: false,
          error: 'Failed to deactivate partner',
        });
      }
    },
  });

  /**
   * GET /api/admin/partners/:id/stats
   * Get detailed stats for a specific partner
   */
  fastify.get('/:id/stats', {
    schema: {
      description: 'Get partner statistics',
      tags: ['admin', 'partners'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
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
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        if (request.user?.role !== 'admin') {
          return reply.status(403).send({
            success: false,
            error: 'Admin access required',
          });
        }

        const result = await partnerService.getPartnerStats(request.params.id);

        return reply.send({ success: true, data: result });
      } catch (error) {
        logger.error({ error, userId: request.params.id }, 'Failed to get partner stats');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get partner stats',
        });
      }
    },
  });

  /**
   * GET /api/admin/partner-settings
   * Get partner program settings
   */
  fastify.get('/settings', {
    schema: {
      description: 'Get partner program settings',
      tags: ['admin', 'partners'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                isEnabled: { type: 'boolean' },
                level1Percent: { type: 'number' },
                level2Percent: { type: 'number' },
                level3Percent: { type: 'number' },
                taxPercent: { type: 'number' },
                minPayoutAmount: { type: 'number' },
                paymentSystemFee: { type: 'number' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
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
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (request.user?.role !== 'admin') {
          return reply.status(403).send({
            success: false,
            error: 'Admin access required',
          });
        }

        const result = await partnerService.getSettings();

        return reply.send({ success: true, data: result });
      } catch (error) {
        logger.error({ error }, 'Failed to get partner settings');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get partner settings',
        });
      }
    },
  });

  /**
   * PUT /api/admin/partner-settings
   * Update partner program settings
   */
  fastify.put('/settings', {
    schema: {
      description: 'Update partner program settings',
      tags: ['admin', 'partners'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          isEnabled: { type: 'boolean' },
          level1Percent: { type: 'number', minimum: 0, maximum: 100 },
          level2Percent: { type: 'number', minimum: 0, maximum: 100 },
          level3Percent: { type: 'number', minimum: 0, maximum: 100 },
          taxPercent: { type: 'number', minimum: 0, maximum: 100 },
          minPayoutAmount: { type: 'number', minimum: 0 },
          paymentSystemFee: { type: 'number', minimum: 0, maximum: 100 },
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
                id: { type: 'string' },
                isEnabled: { type: 'boolean' },
                level1Percent: { type: 'number' },
                level2Percent: { type: 'number' },
                level3Percent: { type: 'number' },
                taxPercent: { type: 'number' },
                minPayoutAmount: { type: 'number' },
                paymentSystemFee: { type: 'number' },
              },
            },
            message: { type: 'string' },
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
      isEnabled?: boolean;
      level1Percent?: number;
      level2Percent?: number;
      level3Percent?: number;
      taxPercent?: number;
      minPayoutAmount?: number;
      paymentSystemFee?: number;
    } }>, reply: FastifyReply) => {
      try {
        if (request.user?.role !== 'admin') {
          return reply.status(403).send({
            success: false,
            error: 'Admin access required',
          });
        }

        const result = await partnerService.updateSettings(request.user.userId, {
          isEnabled: request.body.isEnabled,
          level1Percent: request.body.level1Percent,
          level2Percent: request.body.level2Percent,
          level3Percent: request.body.level3Percent,
          taxPercent: request.body.taxPercent,
          minPayoutAmount: request.body.minPayoutAmount,
          paymentSystemFee: request.body.paymentSystemFee,
        });

        return reply.send({
          success: true,
          data: result,
          message: 'Settings updated successfully',
        });
      } catch (error) {
        logger.error({ error }, 'Failed to update partner settings');
        return reply.status(500).send({
          success: false,
          error: 'Failed to update partner settings',
        });
      }
    },
  });

  /**
   * GET /api/admin/partner-payouts
   * Get all payout requests
   */
  fastify.get('/payouts', {
    schema: {
      description: 'Get all payout requests',
      tags: ['admin', 'partners'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'completed'] },
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
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      partnerId: { type: 'string' },
                      amount: { type: 'number' },
                      status: { type: 'string' },
                      paymentMethod: { type: 'string' },
                      paymentDetails: { type: 'object' },
                      notes: { type: 'string' },
                      processedBy: { type: 'string' },
                      processedAt: { type: 'string' },
                      createdAt: { type: 'string' },
                    },
                  },
                },
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
    handler: async (request: FastifyRequest<{ Querystring: { status?: string; page?: number; limit?: number } }>, reply: FastifyReply) => {
      try {
        if (request.user?.role !== 'admin') {
          return reply.status(403).send({
            success: false,
            error: 'Admin access required',
          });
        }

        const result = await partnerService.getAllPayouts({
          status: request.query.status,
          page: request.query.page,
          limit: request.query.limit,
        });

        return reply.send({ success: true, data: result });
      } catch (error) {
        logger.error({ error }, 'Failed to get payouts');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get payouts',
        });
      }
    },
  });

  /**
   * POST /api/admin/partner-payouts/:id/process
   * Process a payout request
   */
  fastify.post('/payouts/:id/process', {
    schema: {
      description: 'Process payout request',
      tags: ['admin', 'partners'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['approved', 'rejected', 'completed'] },
          notes: { type: 'string' },
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
                id: { type: 'string' },
                status: { type: 'string' },
                processedAt: { type: 'string' },
              },
            },
            message: { type: 'string' },
          },
        },
        404: {
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
    handler: async (request: FastifyRequest<{ Params: { id: string }; Body: { status: 'approved' | 'rejected' | 'completed'; notes?: string } }>, reply: FastifyReply) => {
      try {
        if (request.user?.role !== 'admin') {
          return reply.status(403).send({
            success: false,
            error: 'Admin access required',
          });
        }

        const result = await partnerService.processPayout(
          request.params.id,
          request.user.userId,
          request.body.status,
          request.body.notes
        );

        return reply.send({
          success: true,
          data: result,
          message: `Payout ${request.body.status} successfully`,
        });
      } catch (error) {
        logger.error({ error, payoutId: request.params.id }, 'Failed to process payout');
        if (error instanceof Error && error.message === 'Payout not found') {
          return reply.status(404).send({
            success: false,
            error: 'Payout not found',
          });
        }
        if (error instanceof Error && error.message === 'Payout has already been processed') {
          return reply.status(400).send({
            success: false,
            error: 'Payout has already been processed',
          });
        }
        return reply.status(500).send({
          success: false,
          error: 'Failed to process payout',
        });
      }
    },
  });
}

export default adminPartnerRoutes;
