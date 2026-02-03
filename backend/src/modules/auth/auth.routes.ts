import type { FastifyInstance } from 'fastify';
import { handleLogin, handleRegister, handleGetMe, handleLogout, handleTelegramAuth, handleSetupSuperAdmin, handleGetSetupStatus } from './auth.controller.js';

/**
 * Register authentication routes
 * @param fastify Fastify instance
 */
export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /auth/login
   * Login user
   */
  fastify.post('/login', {
    schema: {
      description: 'Login user',
      tags: ['auth'],
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 3 },
          password: { type: 'string', minLength: 6 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
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
    handler: handleLogin,
  });

  /**
   * POST /auth/register
   * Register new user
   */
  fastify.post('/register', {
    schema: {
      description: 'Register new user',
      tags: ['auth'],
      body: {
        type: 'object',
        required: ['username', 'password', 'name'],
        properties: {
          username: { type: 'string', minLength: 3 },
          password: { type: 'string', minLength: 6 },
          name: { type: 'string', minLength: 2 },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
        409: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    handler: handleRegister,
  });

  /**
   * GET /auth/me
   * Get current user
   */
  fastify.get('/me', {
    schema: {
      description: 'Get current user',
      tags: ['auth'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
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
    handler: handleGetMe,
  });

  /**
   * POST /auth/logout
   * Logout user
   */
  fastify.post('/logout', {
    schema: {
      description: 'Logout user',
      tags: ['auth'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleLogout,
  });

  /**
   * POST /auth/telegram
   * Authenticate via Telegram WebApp
   */
  fastify.post('/telegram', {
    schema: {
      description: 'Authenticate via Telegram WebApp',
      tags: ['auth'],
      body: {
        type: 'object',
        required: ['initData'],
        properties: {
          initData: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            token: { type: 'string' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
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
    handler: handleTelegramAuth,
  });

  /**
   * GET /auth/setup-status
   * Check if initial setup is required
   */
  fastify.get('/setup-status', {
    schema: {
      description: 'Check if initial setup is required',
      tags: ['auth'],
      response: {
        200: {
          type: 'object',
          properties: {
            needsSetup: { type: 'boolean' },
          },
        },
      },
    },
    handler: handleGetSetupStatus,
  });

  /**
   * POST /auth/setup
   * Create initial super admin (setup)
   */
  fastify.post('/setup', {
    schema: {
      description: 'Create initial super admin',
      tags: ['auth'],
      body: {
        type: 'object',
        required: ['username', 'password', 'telegramId'],
        properties: {
          username: { type: 'string', minLength: 3 },
          password: { type: 'string', minLength: 8 },
          telegramId: { type: 'string', pattern: '^\\d+$' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
        403: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        409: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    handler: handleSetupSuperAdmin,
  });
}
