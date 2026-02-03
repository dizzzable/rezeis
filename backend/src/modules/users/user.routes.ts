import type { FastifyInstance } from 'fastify';
import {
  handleGetUsers,
  handleGetUserById,
  handleCreateUser,
  handleUpdateUser,
  handleDeleteUser,
  handleBlockUser,
  handleUnblockUser,
  handleGetUserSubscriptions,
  handleGetUserDetails,
} from './user.controller.js';
import { userDetailsResponseSchema } from './user.schemas.js';

/**
 * Register user routes
 * @param fastify - Fastify instance
 */
export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /users
   * Get users list with pagination and filters
   */
  fastify.get('/', {
    schema: {
      description: 'Get users list',
      tags: ['users'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 20 },
          role: { type: 'string', enum: ['admin', 'user'] },
          isActive: { type: 'boolean' },
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
                data: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      username: { type: 'string' },
                      telegramId: { type: 'string' },
                      firstName: { type: 'string' },
                      lastName: { type: 'string' },
                      photoUrl: { type: 'string' },
                      role: { type: 'string' },
                      isActive: { type: 'boolean' },
                      lastLoginAt: { type: 'string' },
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
    handler: handleGetUsers,
  });

  /**
   * GET /users/:id
   * Get user by ID
   */
  fastify.get('/:id', {
    schema: {
      description: 'Get user by ID',
      tags: ['users'],
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
                username: { type: 'string' },
                telegramId: { type: 'string' },
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                photoUrl: { type: 'string' },
                role: { type: 'string' },
                isActive: { type: 'boolean' },
                lastLoginAt: { type: 'string' },
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
    handler: handleGetUserById,
  });

  /**
   * POST /users
   * Create new user
   */
  fastify.post('/', {
    schema: {
      description: 'Create new user',
      tags: ['users'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['username'],
        properties: {
          username: { type: 'string', minLength: 3 },
          password: { type: 'string', minLength: 6 },
          telegramId: { type: 'string' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          photoUrl: { type: 'string' },
          role: { type: 'string', enum: ['admin', 'user'], default: 'user' },
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
                username: { type: 'string' },
                telegramId: { type: 'string' },
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                photoUrl: { type: 'string' },
                role: { type: 'string' },
                isActive: { type: 'boolean' },
                lastLoginAt: { type: 'string' },
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
    handler: handleCreateUser,
  });

  /**
   * PUT /users/:id
   * Update user
   */
  fastify.put('/:id', {
    schema: {
      description: 'Update user',
      tags: ['users'],
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
          username: { type: 'string', minLength: 3 },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          photoUrl: { type: 'string' },
          role: { type: 'string', enum: ['admin', 'user'] },
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
                username: { type: 'string' },
                telegramId: { type: 'string' },
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                photoUrl: { type: 'string' },
                role: { type: 'string' },
                isActive: { type: 'boolean' },
                lastLoginAt: { type: 'string' },
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
    handler: handleUpdateUser,
  });

  /**
   * DELETE /users/:id
   * Delete user
   */
  fastify.delete('/:id', {
    schema: {
      description: 'Delete user',
      tags: ['users'],
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
    handler: handleDeleteUser,
  });

  /**
   * GET /users/:id/subscriptions
   * Get user subscriptions
   */
  fastify.get('/:id/subscriptions', {
    schema: {
      description: 'Get user subscriptions',
      tags: ['users'],
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
    handler: handleGetUserSubscriptions,
  });

  /**
   * POST /users/:id/block
   * Block user
   */
  fastify.post('/:id/block', {
    schema: {
      description: 'Block user',
      tags: ['users'],
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
                username: { type: 'string' },
                telegramId: { type: 'string' },
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                photoUrl: { type: 'string' },
                role: { type: 'string' },
                isActive: { type: 'boolean' },
                lastLoginAt: { type: 'string' },
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
    handler: handleBlockUser,
  });

  /**
   * POST /users/:id/unblock
   * Unblock user
   */
  fastify.post('/:id/unblock', {
    schema: {
      description: 'Unblock user',
      tags: ['users'],
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
                username: { type: 'string' },
                telegramId: { type: 'string' },
                firstName: { type: 'string' },
                lastName: { type: 'string' },
                photoUrl: { type: 'string' },
                role: { type: 'string' },
                isActive: { type: 'boolean' },
                lastLoginAt: { type: 'string' },
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
    handler: handleUnblockUser,
  });

  /**
   * GET /users/:id/details
   * Get comprehensive user details
   */
  fastify.get('/:id/details', {
    schema: {
      description: 'Get comprehensive user details with subscriptions, partner info, referrals',
      tags: ['users'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
        },
      },
      response: {
        200: userDetailsResponseSchema,
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
    handler: handleGetUserDetails,
  });
}
