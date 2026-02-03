import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { getPool } from '../../config/database.js';
import { MultisubscriptionRepository } from '../../repositories/multisubscription.repository.js';
import { MultisubscriptionService } from './multisubscription.service.js';
import { MultisubscriptionController } from './multisubscription.controller.js';
import {
  createMultisubscriptionSchema,
  updateMultisubscriptionSchema,
  toggleMultisubscriptionSchema,
  listMultisubscriptionsQuerySchema,
  multisubscriptionIdParamSchema,
  multisubscriptionResponseSchema,
  paginatedMultisubscriptionsResponseSchema,
  multisubscriptionStatisticsSchema,
} from './multisubscription.schemas.js';

/**
 * Configure multisubscription routes
 */
export async function multisubscriptionRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions
): Promise<void> {
  void options;
  const pool = getPool();
  const repository = new MultisubscriptionRepository(pool);
  const service = new MultisubscriptionService(repository);
  const controller = new MultisubscriptionController(service);

  // GET /multisubscriptions - List all multisubscriptions
  fastify.get('/', {
    schema: {
      tags: ['multisubscriptions'],
      summary: 'List all multisubscriptions',
      description: 'Get paginated list of multisubscriptions with filters',
      querystring: listMultisubscriptionsQuerySchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: paginatedMultisubscriptionsResponseSchema,
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleListMultisubscriptions,
  });

  // GET /multisubscriptions/statistics - Get statistics
  fastify.get('/statistics', {
    schema: {
      tags: ['multisubscriptions'],
      summary: 'Get multisubscription statistics',
      description: 'Get statistics about multisubscriptions',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: multisubscriptionStatisticsSchema,
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleGetStatistics,
  });

  // GET /multisubscriptions/user/:userId - Get user's multisubscriptions
  fastify.get('/user/:userId', {
    schema: {
      tags: ['multisubscriptions'],
      summary: 'Get user multisubscriptions',
      description: 'Get all multisubscriptions for a specific user',
      params: {
        type: 'object',
        properties: {
          userId: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: multisubscriptionResponseSchema,
            },
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleGetMultisubscriptionsByUser,
  });

  // GET /multisubscriptions/:id - Get multisubscription by ID
  fastify.get('/:id', {
    schema: {
      tags: ['multisubscriptions'],
      summary: 'Get multisubscription by ID',
      description: 'Get a single multisubscription by its ID',
      params: multisubscriptionIdParamSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: multisubscriptionResponseSchema,
          },
        },
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleGetMultisubscription,
  });

  // POST /multisubscriptions - Create new multisubscription
  fastify.post('/', {
    schema: {
      tags: ['multisubscriptions'],
      summary: 'Create multisubscription',
      description: 'Create a new multisubscription',
      body: createMultisubscriptionSchema,
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: multisubscriptionResponseSchema,
          },
        },
        400: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleCreateMultisubscription,
  });

  // PATCH /multisubscriptions/:id - Update multisubscription
  fastify.patch('/:id', {
    schema: {
      tags: ['multisubscriptions'],
      summary: 'Update multisubscription',
      description: 'Update an existing multisubscription',
      params: multisubscriptionIdParamSchema,
      body: updateMultisubscriptionSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: multisubscriptionResponseSchema,
          },
        },
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleUpdateMultisubscription,
  });

  // DELETE /multisubscriptions/:id - Delete multisubscription
  fastify.delete('/:id', {
    schema: {
      tags: ['multisubscriptions'],
      summary: 'Delete multisubscription',
      description: 'Delete a multisubscription by ID',
      params: multisubscriptionIdParamSchema,
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
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleDeleteMultisubscription,
  });

  // POST /multisubscriptions/:id/toggle - Toggle multisubscription status
  fastify.post('/:id/toggle', {
    schema: {
      tags: ['multisubscriptions'],
      summary: 'Toggle multisubscription status',
      description: 'Toggle the active status of a multisubscription',
      params: multisubscriptionIdParamSchema,
      body: toggleMultisubscriptionSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: multisubscriptionResponseSchema,
          },
        },
        404: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleToggleMultisubscription,
  });
}
