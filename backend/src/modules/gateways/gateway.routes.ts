import type { FastifyInstance } from 'fastify';
import {
  handleGetGateways,
  handleGetActiveGateways,
  handleGetDefaultGateway,
  handleGetGatewayById,
  handleCreateGateway,
  handleUpdateGateway,
  handleDeleteGateway,
  handleToggleGateway,
  handleSetDefaultGateway,
} from './gateway.controller.js';

/**
 * Register gateway routes
 * @param fastify - Fastify instance
 */
export async function gatewayRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /gateways
   * Get all gateways
   */
  fastify.get('/', {
    schema: {
      description: 'Get all gateways',
      tags: ['gateways'],
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
                  name: { type: 'string' },
                  type: { type: 'string' },
                  isActive: { type: 'boolean' },
                  isDefault: { type: 'boolean' },
                  config: { type: 'object' },
                  displayOrder: { type: 'number' },
                  iconUrl: { type: 'string' },
                  description: { type: 'string' },
                  supportedCurrencies: { type: 'array', items: { type: 'string' } },
                  minAmount: { type: 'number' },
                  maxAmount: { type: 'number' },
                  feePercent: { type: 'number' },
                  feeFixed: { type: 'number' },
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
    handler: handleGetGateways,
  });

  /**
   * GET /gateways/active
   * Get active gateways
   */
  fastify.get('/active', {
    schema: {
      description: 'Get active gateways',
      tags: ['gateways'],
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
                  name: { type: 'string' },
                  type: { type: 'string' },
                  isActive: { type: 'boolean' },
                  isDefault: { type: 'boolean' },
                  config: { type: 'object' },
                  displayOrder: { type: 'number' },
                  iconUrl: { type: 'string' },
                  description: { type: 'string' },
                  supportedCurrencies: { type: 'array', items: { type: 'string' } },
                  minAmount: { type: 'number' },
                  maxAmount: { type: 'number' },
                  feePercent: { type: 'number' },
                  feeFixed: { type: 'number' },
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
    handler: handleGetActiveGateways,
  });

  /**
   * GET /gateways/default
   * Get default gateway
   */
  fastify.get('/default', {
    schema: {
      description: 'Get default gateway',
      tags: ['gateways'],
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
                name: { type: 'string' },
                type: { type: 'string' },
                isActive: { type: 'boolean' },
                isDefault: { type: 'boolean' },
                config: { type: 'object' },
                displayOrder: { type: 'number' },
                iconUrl: { type: 'string' },
                description: { type: 'string' },
                supportedCurrencies: { type: 'array', items: { type: 'string' } },
                minAmount: { type: 'number' },
                maxAmount: { type: 'number' },
                feePercent: { type: 'number' },
                feeFixed: { type: 'number' },
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
    handler: handleGetDefaultGateway,
  });

  /**
   * GET /gateways/:id
   * Get gateway by ID
   */
  fastify.get('/:id', {
    schema: {
      description: 'Get gateway by ID',
      tags: ['gateways'],
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
                name: { type: 'string' },
                type: { type: 'string' },
                isActive: { type: 'boolean' },
                isDefault: { type: 'boolean' },
                config: { type: 'object' },
                displayOrder: { type: 'number' },
                iconUrl: { type: 'string' },
                description: { type: 'string' },
                supportedCurrencies: { type: 'array', items: { type: 'string' } },
                minAmount: { type: 'number' },
                maxAmount: { type: 'number' },
                feePercent: { type: 'number' },
                feeFixed: { type: 'number' },
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
    handler: handleGetGatewayById,
  });

  /**
   * POST /gateways
   * Create new gateway
   */
  fastify.post('/', {
    schema: {
      description: 'Create new gateway',
      tags: ['gateways'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: { type: 'string', minLength: 1 },
          type: { type: 'string', enum: ['stripe', 'paypal', 'cryptomus', 'yookassa', 'custom'] },
          isActive: { type: 'boolean', default: true },
          isDefault: { type: 'boolean', default: false },
          config: { type: 'object' },
          displayOrder: { type: 'number', default: 0 },
          iconUrl: { type: 'string' },
          description: { type: 'string' },
          supportedCurrencies: { type: 'array', items: { type: 'string' } },
          minAmount: { type: 'number', minimum: 0 },
          maxAmount: { type: 'number', minimum: 0 },
          feePercent: { type: 'number', minimum: 0, maximum: 100 },
          feeFixed: { type: 'number', minimum: 0 },
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
                name: { type: 'string' },
                type: { type: 'string' },
                isActive: { type: 'boolean' },
                isDefault: { type: 'boolean' },
                config: { type: 'object' },
                displayOrder: { type: 'number' },
                iconUrl: { type: 'string' },
                description: { type: 'string' },
                supportedCurrencies: { type: 'array', items: { type: 'string' } },
                minAmount: { type: 'number' },
                maxAmount: { type: 'number' },
                feePercent: { type: 'number' },
                feeFixed: { type: 'number' },
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
    handler: handleCreateGateway,
  });

  /**
   * PUT /gateways/:id
   * Update gateway
   */
  fastify.put('/:id', {
    schema: {
      description: 'Update gateway',
      tags: ['gateways'],
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
          name: { type: 'string', minLength: 1 },
          type: { type: 'string', enum: ['stripe', 'paypal', 'cryptomus', 'yookassa', 'custom'] },
          isActive: { type: 'boolean' },
          isDefault: { type: 'boolean' },
          config: { type: 'object' },
          displayOrder: { type: 'number' },
          iconUrl: { type: 'string' },
          description: { type: 'string' },
          supportedCurrencies: { type: 'array', items: { type: 'string' } },
          minAmount: { type: 'number', minimum: 0 },
          maxAmount: { type: 'number', minimum: 0 },
          feePercent: { type: 'number', minimum: 0, maximum: 100 },
          feeFixed: { type: 'number', minimum: 0 },
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
                name: { type: 'string' },
                type: { type: 'string' },
                isActive: { type: 'boolean' },
                isDefault: { type: 'boolean' },
                config: { type: 'object' },
                displayOrder: { type: 'number' },
                iconUrl: { type: 'string' },
                description: { type: 'string' },
                supportedCurrencies: { type: 'array', items: { type: 'string' } },
                minAmount: { type: 'number' },
                maxAmount: { type: 'number' },
                feePercent: { type: 'number' },
                feeFixed: { type: 'number' },
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
    handler: handleUpdateGateway,
  });

  /**
   * DELETE /gateways/:id
   * Delete gateway
   */
  fastify.delete('/:id', {
    schema: {
      description: 'Delete gateway',
      tags: ['gateways'],
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
        400: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
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
    handler: handleDeleteGateway,
  });

  /**
   * POST /gateways/:id/toggle
   * Toggle gateway active status
   */
  fastify.post('/:id/toggle', {
    schema: {
      description: 'Toggle gateway active status',
      tags: ['gateways'],
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
                name: { type: 'string' },
                type: { type: 'string' },
                isActive: { type: 'boolean' },
                isDefault: { type: 'boolean' },
                config: { type: 'object' },
                displayOrder: { type: 'number' },
                iconUrl: { type: 'string' },
                description: { type: 'string' },
                supportedCurrencies: { type: 'array', items: { type: 'string' } },
                minAmount: { type: 'number' },
                maxAmount: { type: 'number' },
                feePercent: { type: 'number' },
                feeFixed: { type: 'number' },
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
    handler: handleToggleGateway,
  });

  /**
   * POST /gateways/:id/default
   * Set gateway as default
   */
  fastify.post('/:id/default', {
    schema: {
      description: 'Set gateway as default',
      tags: ['gateways'],
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
                name: { type: 'string' },
                type: { type: 'string' },
                isActive: { type: 'boolean' },
                isDefault: { type: 'boolean' },
                config: { type: 'object' },
                displayOrder: { type: 'number' },
                iconUrl: { type: 'string' },
                description: { type: 'string' },
                supportedCurrencies: { type: 'array', items: { type: 'string' } },
                minAmount: { type: 'number' },
                maxAmount: { type: 'number' },
                feePercent: { type: 'number' },
                feeFixed: { type: 'number' },
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
    handler: handleSetDefaultGateway,
  });
}
