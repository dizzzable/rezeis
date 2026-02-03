import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createPaymentGatewayService, GatewayNotFoundError, GatewayAlreadyExistsError, InvalidGatewayConfigError } from './payment-gateway.service.js';
import { logger } from '../../../utils/logger.js';
import type { CreateGatewayDTO, UpdateGatewayDTO } from './types.js';

/**
 * Register admin payment gateway routes
 * @param fastify - Fastify instance
 */
export async function adminPaymentGatewayRoutes(fastify: FastifyInstance): Promise<void> {
  const paymentGatewayService = createPaymentGatewayService(fastify.pg);

  /**
   * GET /api/admin/payment-gateways
   * Get all payment gateways with summary info
   */
  fastify.get('/', {
    schema: {
      description: 'Get all payment gateways',
      tags: ['admin', 'payment-gateways'],
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
                  displayName: { type: 'string' },
                  isEnabled: { type: 'boolean' },
                  sortOrder: { type: 'number' },
                  status: { type: 'string' },
                  icon: { type: 'string' },
                  supportedCurrencies: { type: 'array', items: { type: 'string' } },
                  webhookUrl: { type: 'string' },
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
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const baseUrl = `${request.protocol}://${request.hostname}`;
        const gateways = await paymentGatewayService.getAll(baseUrl);
        return reply.send({ success: true, data: gateways });
      } catch (error) {
        logger.error({ error }, 'Failed to get payment gateways');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get payment gateways',
        });
      }
    },
  });

  /**
   * GET /api/admin/payment-gateways/:id
   * Get payment gateway by ID
   */
  fastify.get('/:id', {
    schema: {
      description: 'Get payment gateway by ID',
      tags: ['admin', 'payment-gateways'],
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
                displayName: { type: 'string' },
                isEnabled: { type: 'boolean' },
                sortOrder: { type: 'number' },
                config: { type: 'object' },
                webhookSecret: { type: 'string' },
                allowedIps: { type: 'array', items: { type: 'string' } },
                status: { type: 'string' },
                description: { type: 'string' },
                icon: { type: 'string' },
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
    handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const gateway = await paymentGatewayService.getById(request.params.id);
        if (!gateway) {
          return reply.status(404).send({
            success: false,
            error: 'Gateway not found',
          });
        }
        return reply.send({ success: true, data: gateway });
      } catch (error) {
        logger.error({ error, gatewayId: request.params.id }, 'Failed to get payment gateway');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get payment gateway',
        });
      }
    },
  });

  /**
   * POST /api/admin/payment-gateways
   * Create new payment gateway
   */
  fastify.post('/', {
    schema: {
      description: 'Create new payment gateway',
      tags: ['admin', 'payment-gateways'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name', 'displayName', 'config'],
        properties: {
          name: { type: 'string', enum: ['cryptopay', 'yookassa', 'heleket', 'pal24', 'platega', 'wata', 'telegram-stars'] },
          displayName: { type: 'string', minLength: 1 },
          config: { type: 'object' },
          isEnabled: { type: 'boolean', default: false },
          sortOrder: { type: 'number', default: 0 },
          allowedIps: { type: 'array', items: { type: 'string' } },
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
                displayName: { type: 'string' },
                isEnabled: { type: 'boolean' },
                sortOrder: { type: 'number' },
                status: { type: 'string' },
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
    handler: async (request: FastifyRequest<{ Body: CreateGatewayDTO }>, reply: FastifyReply) => {
      try {
        const gateway = await paymentGatewayService.create(request.body);
        return reply.status(201).send({
          success: true,
          data: gateway,
          message: 'Gateway created successfully',
        });
      } catch (error) {
        if (error instanceof GatewayAlreadyExistsError) {
          return reply.status(409).send({
            success: false,
            error: error.message,
          });
        }
        if (error instanceof InvalidGatewayConfigError) {
          return reply.status(400).send({
            success: false,
            error: error.message,
          });
        }
        logger.error({ error }, 'Failed to create payment gateway');
        return reply.status(500).send({
          success: false,
          error: 'Failed to create payment gateway',
        });
      }
    },
  });

  /**
   * PUT /api/admin/payment-gateways/:id
   * Update payment gateway
   */
  fastify.put('/:id', {
    schema: {
      description: 'Update payment gateway',
      tags: ['admin', 'payment-gateways'],
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
          displayName: { type: 'string', minLength: 1 },
          config: { type: 'object' },
          isEnabled: { type: 'boolean' },
          sortOrder: { type: 'number' },
          allowedIps: { type: 'array', items: { type: 'string' } },
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
                displayName: { type: 'string' },
                isEnabled: { type: 'boolean' },
                sortOrder: { type: 'number' },
                status: { type: 'string' },
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
    handler: async (request: FastifyRequest<{ Params: { id: string }; Body: UpdateGatewayDTO }>, reply: FastifyReply) => {
      try {
        const gateway = await paymentGatewayService.update(request.params.id, request.body);
        return reply.send({
          success: true,
          data: gateway,
          message: 'Gateway updated successfully',
        });
      } catch (error) {
        if (error instanceof GatewayNotFoundError) {
          return reply.status(404).send({
            success: false,
            error: error.message,
          });
        }
        if (error instanceof InvalidGatewayConfigError) {
          return reply.status(400).send({
            success: false,
            error: error.message,
          });
        }
        logger.error({ error, gatewayId: request.params.id }, 'Failed to update payment gateway');
        return reply.status(500).send({
          success: false,
          error: 'Failed to update payment gateway',
        });
      }
    },
  });

  /**
   * DELETE /api/admin/payment-gateways/:id
   * Delete payment gateway
   */
  fastify.delete('/:id', {
    schema: {
      description: 'Delete payment gateway',
      tags: ['admin', 'payment-gateways'],
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
    handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await paymentGatewayService.delete(request.params.id);
        return reply.send({
          success: true,
          message: 'Gateway deleted successfully',
        });
      } catch (error) {
        if (error instanceof GatewayNotFoundError) {
          return reply.status(404).send({
            success: false,
            error: error.message,
          });
        }
        logger.error({ error, gatewayId: request.params.id }, 'Failed to delete payment gateway');
        return reply.status(500).send({
          success: false,
          error: 'Failed to delete payment gateway',
        });
      }
    },
  });

  /**
   * POST /api/admin/payment-gateways/:id/toggle
   * Toggle gateway enabled status
   */
  fastify.post('/:id/toggle', {
    schema: {
      description: 'Toggle gateway enabled status',
      tags: ['admin', 'payment-gateways'],
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
                isEnabled: { type: 'boolean' },
                status: { type: 'string' },
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
    handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const gateway = await paymentGatewayService.toggle(request.params.id);
        return reply.send({
          success: true,
          data: {
            id: gateway.id,
            isEnabled: gateway.isEnabled,
            status: gateway.status,
          },
          message: `Gateway ${gateway.isEnabled ? 'enabled' : 'disabled'} successfully`,
        });
      } catch (error) {
        if (error instanceof GatewayNotFoundError) {
          return reply.status(404).send({
            success: false,
            error: error.message,
          });
        }
        logger.error({ error, gatewayId: request.params.id }, 'Failed to toggle payment gateway');
        return reply.status(500).send({
          success: false,
          error: 'Failed to toggle payment gateway',
        });
      }
    },
  });

  /**
   * POST /api/admin/payment-gateways/:id/test
   * Test gateway connection
   */
  fastify.post('/:id/test', {
    schema: {
      description: 'Test gateway connection',
      tags: ['admin', 'payment-gateways'],
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
                success: { type: 'boolean' },
                message: { type: 'string' },
                responseTime: { type: 'number' },
                details: { type: 'object' },
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
    handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const result = await paymentGatewayService.testConnection(request.params.id);
        return reply.send({
          success: result.success,
          data: result,
        });
      } catch (error) {
        if (error instanceof GatewayNotFoundError) {
          return reply.status(404).send({
            success: false,
            error: error.message,
          });
        }
        logger.error({ error, gatewayId: request.params.id }, 'Failed to test gateway connection');
        return reply.status(500).send({
          success: false,
          error: 'Failed to test gateway connection',
        });
      }
    },
  });

  /**
   * GET /api/admin/payment-gateways/:id/webhook-url
   * Get webhook URL for gateway
   */
  fastify.get('/:id/webhook-url', {
    schema: {
      description: 'Get webhook URL for gateway',
      tags: ['admin', 'payment-gateways'],
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
                gateway: { type: 'string' },
                webhookUrl: { type: 'string' },
                verificationUrl: { type: 'string' },
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
    handler: async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const gateway = await paymentGatewayService.getById(request.params.id);
        if (!gateway) {
          return reply.status(404).send({
            success: false,
            error: 'Gateway not found',
          });
        }

        const baseUrl = `${request.protocol}://${request.hostname}`;
        const webhookUrl = paymentGatewayService.getWebhookUrl(gateway.name, baseUrl);

        return reply.send({
          success: true,
          data: {
            gateway: gateway.name,
            webhookUrl,
            verificationUrl: `${webhookUrl}/verify`,
          },
        });
      } catch (error) {
        logger.error({ error, gatewayId: request.params.id }, 'Failed to get webhook URL');
        return reply.status(500).send({
          success: false,
          error: 'Failed to get webhook URL',
        });
      }
    },
  });

  /**
   * POST /api/admin/payment-gateways/initialize
   * Initialize default gateways (admin only)
   */
  fastify.post('/initialize', {
    schema: {
      description: 'Initialize default payment gateways',
      tags: ['admin', 'payment-gateways'],
      security: [{ bearerAuth: [] }],
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
      },
    },
    onRequest: [fastify.authenticate],
    handler: async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        await paymentGatewayService.initializeDefaultGateways();
        return reply.send({
          success: true,
          message: 'Default gateways initialized successfully',
        });
      } catch (error) {
        logger.error({ error }, 'Failed to initialize default gateways');
        return reply.status(500).send({
          success: false,
          error: 'Failed to initialize default gateways',
        });
      }
    },
  });
}
