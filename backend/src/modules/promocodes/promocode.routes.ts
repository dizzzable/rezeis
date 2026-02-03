import type { FastifyInstance } from 'fastify';
import {
  handleGetPromocodes,
  handleGetActivePromocodes,
  handleGetPromocodeById,
  handleCreatePromocode,
  handleUpdatePromocode,
  handleDeletePromocode,
  handleTogglePromocode,
  handleValidatePromocode,
  handleApplyPromocode,
} from './promocode.controller.js';

/**
 * Register promocode routes
 * @param fastify - Fastify instance
 */
export async function promocodeRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /promocodes
   * Get all promocodes
   */
  fastify.get('/', {
    schema: {
      description: 'Get all promocodes',
      tags: ['promocodes'],
      security: [{ bearerAuth: [] }],
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
                  code: { type: 'string' },
                  description: { type: 'string' },
                  discountType: { type: 'string', enum: ['percentage', 'fixed_amount'] },
                  discountValue: { type: 'number' },
                  maxUses: { type: 'number' },
                  usedCount: { type: 'number' },
                  expiresAt: { type: 'string' },
                  isActive: { type: 'boolean' },
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
    handler: handleGetPromocodes,
  });

  /**
   * GET /promocodes/active
   * Get active promocodes
   */
  fastify.get('/active', {
    schema: {
      description: 'Get active promocodes',
      tags: ['promocodes'],
      security: [{ bearerAuth: [] }],
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
                  code: { type: 'string' },
                  description: { type: 'string' },
                  discountType: { type: 'string', enum: ['percentage', 'fixed_amount'] },
                  discountValue: { type: 'number' },
                  maxUses: { type: 'number' },
                  usedCount: { type: 'number' },
                  expiresAt: { type: 'string' },
                  isActive: { type: 'boolean' },
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
    handler: handleGetActivePromocodes,
  });

  /**
   * GET /promocodes/:id
   * Get promocode by ID
   */
  fastify.get('/:id', {
    schema: {
      description: 'Get promocode by ID',
      tags: ['promocodes'],
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
                code: { type: 'string' },
                description: { type: 'string' },
                discountType: { type: 'string', enum: ['percentage', 'fixed_amount'] },
                discountValue: { type: 'number' },
                maxUses: { type: 'number' },
                usedCount: { type: 'number' },
                expiresAt: { type: 'string' },
                isActive: { type: 'boolean' },
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
    handler: handleGetPromocodeById,
  });

  /**
   * POST /promocodes
   * Create new promocode
   */
  fastify.post('/', {
    schema: {
      description: 'Create new promocode',
      tags: ['promocodes'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['code', 'discountType', 'discountValue'],
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 50 },
          description: { type: 'string' },
          discountType: { type: 'string', enum: ['percentage', 'fixed_amount'] },
          discountValue: { type: 'number', minimum: 0 },
          maxUses: { type: 'number', minimum: 1 },
          expiresAt: { type: 'string' },
          isActive: { type: 'boolean', default: true },
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
                code: { type: 'string' },
                description: { type: 'string' },
                discountType: { type: 'string', enum: ['percentage', 'fixed_amount'] },
                discountValue: { type: 'number' },
                maxUses: { type: 'number' },
                usedCount: { type: 'number' },
                expiresAt: { type: 'string' },
                isActive: { type: 'boolean' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
              },
            },
            message: { type: 'string' },
          },
        },
        409: {
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
    handler: handleCreatePromocode,
  });

  /**
   * PUT /promocodes/:id
   * Update promocode
   */
  fastify.put('/:id', {
    schema: {
      description: 'Update promocode',
      tags: ['promocodes'],
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
          code: { type: 'string', minLength: 1, maxLength: 50 },
          description: { type: 'string' },
          discountType: { type: 'string', enum: ['percentage', 'fixed_amount'] },
          discountValue: { type: 'number', minimum: 0 },
          maxUses: { type: 'number', minimum: 1 },
          expiresAt: { type: 'string' },
          isActive: { type: 'boolean' },
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
                code: { type: 'string' },
                description: { type: 'string' },
                discountType: { type: 'string', enum: ['percentage', 'fixed_amount'] },
                discountValue: { type: 'number' },
                maxUses: { type: 'number' },
                usedCount: { type: 'number' },
                expiresAt: { type: 'string' },
                isActive: { type: 'boolean' },
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
        409: {
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
    handler: handleUpdatePromocode,
  });

  /**
   * DELETE /promocodes/:id
   * Delete promocode
   */
  fastify.delete('/:id', {
    schema: {
      description: 'Delete promocode',
      tags: ['promocodes'],
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
    handler: handleDeletePromocode,
  });

  /**
   * POST /promocodes/:id/toggle
   * Toggle promocode active status
   */
  fastify.post('/:id/toggle', {
    schema: {
      description: 'Toggle promocode active status',
      tags: ['promocodes'],
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
                code: { type: 'string' },
                description: { type: 'string' },
                discountType: { type: 'string', enum: ['percentage', 'fixed_amount'] },
                discountValue: { type: 'number' },
                maxUses: { type: 'number' },
                usedCount: { type: 'number' },
                expiresAt: { type: 'string' },
                isActive: { type: 'boolean' },
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
    handler: handleTogglePromocode,
  });

  /**
   * POST /promocodes/validate
   * Validate promocode
   */
  fastify.post('/validate', {
    schema: {
      description: 'Validate promocode',
      tags: ['promocodes'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string' },
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
                valid: { type: 'boolean' },
                promocode: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    code: { type: 'string' },
                    description: { type: 'string' },
                    discountType: { type: 'string', enum: ['percentage', 'fixed_amount'] },
                    discountValue: { type: 'number' },
                    maxUses: { type: 'number' },
                    usedCount: { type: 'number' },
                    expiresAt: { type: 'string' },
                    isActive: { type: 'boolean' },
                    createdAt: { type: 'string' },
                    updatedAt: { type: 'string' },
                  },
                },
              },
            },
            message: { type: 'string' },
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
    handler: handleValidatePromocode,
  });

  /**
   * POST /promocodes/apply
   * Apply promocode (increment used count)
   */
  fastify.post('/apply', {
    schema: {
      description: 'Apply promocode',
      tags: ['promocodes'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string' },
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
                code: { type: 'string' },
                description: { type: 'string' },
                discountType: { type: 'string', enum: ['percentage', 'fixed_amount'] },
                discountValue: { type: 'number' },
                maxUses: { type: 'number' },
                usedCount: { type: 'number' },
                expiresAt: { type: 'string' },
                isActive: { type: 'boolean' },
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
    handler: handleApplyPromocode,
  });
}
