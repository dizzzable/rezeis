import type { FastifyInstance } from 'fastify';
import {
  handleGetSubscriptions,
  handleGetSubscriptionById,
  handleCreateSubscription,
  handleUpdateSubscription,
  handleDeleteSubscription,
  handleRenewSubscription,
  handleCancelSubscription,
  handleGetExpiringSubscriptions,
} from './subscription.controller.js';

/**
 * Register subscription routes
 * @param fastify - Fastify instance
 */
export async function subscriptionRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /subscriptions
   * Get subscriptions list with pagination and filters
   */
  fastify.get('/', {
    schema: {
      description: 'Get subscriptions list',
      tags: ['subscriptions'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 20 },
          status: { type: 'string', enum: ['active', 'expired', 'cancelled', 'pending'] },
          userId: { type: 'string' },
          planId: { type: 'string' },
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
                data: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      userId: { type: 'string' },
                      planId: { type: 'string' },
                      status: { type: 'string' },
                      startDate: { type: 'string' },
                      endDate: { type: 'string' },
                      remnawaveUuid: { type: 'string' },
                      createdAt: { type: 'string' },
                      updatedAt: { type: 'string' },
                    },
                  },
                },
                total: { type: 'number' },
                page: { type: 'number' },
                limit: { type: 'number' },
                totalPages: { type: 'number' },
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
    handler: handleGetSubscriptions,
  });

  /**
   * GET /subscriptions/expiring
   * Get expiring subscriptions
   */
  fastify.get('/expiring', {
    schema: {
      description: 'Get expiring subscriptions',
      tags: ['subscriptions'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          days: { type: 'number', default: 7 },
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
                  userId: { type: 'string' },
                  planId: { type: 'string' },
                  status: { type: 'string' },
                  startDate: { type: 'string' },
                  endDate: { type: 'string' },
                  remnawaveUuid: { type: 'string' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
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
    handler: handleGetExpiringSubscriptions,
  });

  /**
   * GET /subscriptions/:id
   * Get subscription by ID
   */
  fastify.get('/:id', {
    schema: {
      description: 'Get subscription by ID',
      tags: ['subscriptions'],
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
                id: { type: 'string' },
                userId: { type: 'string' },
                planId: { type: 'string' },
                status: { type: 'string' },
                startDate: { type: 'string' },
                endDate: { type: 'string' },
                remnawaveUuid: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
        404: {
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
    handler: handleGetSubscriptionById,
  });

  /**
   * POST /subscriptions
   * Create new subscription
   */
  fastify.post('/', {
    schema: {
      description: 'Create new subscription',
      tags: ['subscriptions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['userId', 'planId', 'startDate', 'endDate'],
        properties: {
          userId: { type: 'string' },
          planId: { type: 'string' },
          status: { type: 'string', enum: ['active', 'expired', 'cancelled', 'pending'], default: 'active' },
          startDate: { type: 'string', format: 'date-time' },
          endDate: { type: 'string', format: 'date-time' },
          remnawaveUuid: { type: 'string' },
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
                userId: { type: 'string' },
                planId: { type: 'string' },
                status: { type: 'string' },
                startDate: { type: 'string' },
                endDate: { type: 'string' },
                remnawaveUuid: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
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
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleCreateSubscription,
  });

  /**
   * PUT /subscriptions/:id
   * Update subscription
   */
  fastify.put('/:id', {
    schema: {
      description: 'Update subscription',
      tags: ['subscriptions'],
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
          planId: { type: 'string' },
          status: { type: 'string', enum: ['active', 'expired', 'cancelled', 'pending'] },
          startDate: { type: 'string', format: 'date-time' },
          endDate: { type: 'string', format: 'date-time' },
          remnawaveUuid: { type: 'string' },
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
                planId: { type: 'string' },
                status: { type: 'string' },
                startDate: { type: 'string' },
                endDate: { type: 'string' },
                remnawaveUuid: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
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
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleUpdateSubscription,
  });

  /**
   * DELETE /subscriptions/:id
   * Delete subscription
   */
  fastify.delete('/:id', {
    schema: {
      description: 'Delete subscription',
      tags: ['subscriptions'],
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
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleDeleteSubscription,
  });

  /**
   * POST /subscriptions/:id/renew
   * Renew subscription
   */
  fastify.post('/:id/renew', {
    schema: {
      description: 'Renew subscription',
      tags: ['subscriptions'],
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
                id: { type: 'string' },
                userId: { type: 'string' },
                planId: { type: 'string' },
                status: { type: 'string' },
                startDate: { type: 'string' },
                endDate: { type: 'string' },
                remnawaveUuid: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
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
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleRenewSubscription,
  });

  /**
   * POST /subscriptions/:id/cancel
   * Cancel subscription
   */
  fastify.post('/:id/cancel', {
    schema: {
      description: 'Cancel subscription',
      tags: ['subscriptions'],
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
                id: { type: 'string' },
                userId: { type: 'string' },
                planId: { type: 'string' },
                status: { type: 'string' },
                startDate: { type: 'string' },
                endDate: { type: 'string' },
                remnawaveUuid: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
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
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleCancelSubscription,
  });
}
