import type { FastifyInstance } from 'fastify';
import {
  handleGetBroadcasts,
  handleGetBroadcastById,
  handleCreateBroadcast,
  handleUpdateBroadcast,
  handleDeleteBroadcast,
  handleGetAudience,
  handleSendBroadcast,
  handlePreviewBroadcast,
} from './broadcast.controller.js';

/**
 * Register broadcast management routes
 * @param fastify - Fastify instance
 */
export async function broadcastRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/broadcasts
   * Get broadcasts list with pagination
   */
  fastify.get('/', {
    schema: {
      description: 'Get broadcasts list',
      tags: ['broadcasts'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 20 },
          status: { type: 'string', enum: ['draft', 'pending', 'sending', 'completed', 'failed'] },
          audience: { type: 'string', enum: ['ALL', 'PLAN', 'SUBSCRIBED', 'UNSUBSCRIBED', 'EXPIRED', 'TRIAL'] },
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
                      audience: { type: 'string' },
                      planId: { type: 'string' },
                      content: { type: 'string' },
                      mediaUrl: { type: 'string' },
                      mediaType: { type: 'string' },
                      status: { type: 'string' },
                      recipientsCount: { type: 'number' },
                      sentCount: { type: 'number' },
                      failedCount: { type: 'number' },
                      createdBy: { type: 'string' },
                      createdAt: { type: 'string' },
                      sentAt: { type: 'string' },
                      errorMessage: { type: 'string' },
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
    handler: handleGetBroadcasts,
  });

  /**
   * POST /api/broadcasts
   * Create new broadcast
   */
  fastify.post('/', {
    schema: {
      description: 'Create new broadcast',
      tags: ['broadcasts'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['audience', 'content'],
        properties: {
          audience: { type: 'string', enum: ['ALL', 'PLAN', 'SUBSCRIBED', 'UNSUBSCRIBED', 'EXPIRED', 'TRIAL'] },
          planId: { type: 'string' },
          content: { type: 'string', minLength: 1, maxLength: 4000 },
          mediaUrl: { type: 'string', format: 'uri' },
          mediaType: { type: 'string', enum: ['photo', 'video'] },
          buttons: {
            type: 'array',
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', minLength: 1, maxLength: 100 },
                type: { type: 'string', enum: ['url', 'goto'] },
                value: { type: 'string', minLength: 1, maxLength: 500 },
              },
            },
          },
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
                broadcast: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    audience: { type: 'string' },
                    planId: { type: 'string' },
                    content: { type: 'string' },
                    mediaUrl: { type: 'string' },
                    mediaType: { type: 'string' },
                    status: { type: 'string' },
                    recipientsCount: { type: 'number' },
                    sentCount: { type: 'number' },
                    failedCount: { type: 'number' },
                    createdBy: { type: 'string' },
                    createdAt: { type: 'string' },
                  },
                },
                buttons: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      broadcastId: { type: 'string' },
                      text: { type: 'string' },
                      type: { type: 'string' },
                      value: { type: 'string' },
                      createdAt: { type: 'string' },
                    },
                  },
                },
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
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleCreateBroadcast,
  });

  /**
   * GET /api/broadcasts/:id
   * Get broadcast by ID
   */
  fastify.get('/:id', {
    schema: {
      description: 'Get broadcast by ID',
      tags: ['broadcasts'],
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
                broadcast: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    audience: { type: 'string' },
                    planId: { type: 'string' },
                    content: { type: 'string' },
                    mediaUrl: { type: 'string' },
                    mediaType: { type: 'string' },
                    status: { type: 'string' },
                    recipientsCount: { type: 'number' },
                    sentCount: { type: 'number' },
                    failedCount: { type: 'number' },
                    createdBy: { type: 'string' },
                    createdAt: { type: 'string' },
                    sentAt: { type: 'string' },
                    errorMessage: { type: 'string' },
                  },
                },
                buttons: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      broadcastId: { type: 'string' },
                      text: { type: 'string' },
                      type: { type: 'string' },
                      value: { type: 'string' },
                      createdAt: { type: 'string' },
                    },
                  },
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
    handler: handleGetBroadcastById,
  });

  /**
   * PATCH /api/broadcasts/:id
   * Update broadcast
   */
  fastify.patch('/:id', {
    schema: {
      description: 'Update broadcast',
      tags: ['broadcasts'],
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
          audience: { type: 'string', enum: ['ALL', 'PLAN', 'SUBSCRIBED', 'UNSUBSCRIBED', 'EXPIRED', 'TRIAL'] },
          planId: { type: 'string' },
          content: { type: 'string', minLength: 1, maxLength: 4000 },
          mediaUrl: { type: 'string', format: 'uri' },
          mediaType: { type: 'string', enum: ['photo', 'video'] },
          buttons: {
            type: 'array',
            maxItems: 3,
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', minLength: 1, maxLength: 100 },
                type: { type: 'string', enum: ['url', 'goto'] },
                value: { type: 'string', minLength: 1, maxLength: 500 },
              },
            },
          },
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
                broadcast: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    audience: { type: 'string' },
                    planId: { type: 'string' },
                    content: { type: 'string' },
                    mediaUrl: { type: 'string' },
                    mediaType: { type: 'string' },
                    status: { type: 'string' },
                    recipientsCount: { type: 'number' },
                    sentCount: { type: 'number' },
                    failedCount: { type: 'number' },
                    createdBy: { type: 'string' },
                    createdAt: { type: 'string' },
                  },
                },
                buttons: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      broadcastId: { type: 'string' },
                      text: { type: 'string' },
                      type: { type: 'string' },
                      value: { type: 'string' },
                      createdAt: { type: 'string' },
                    },
                  },
                },
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
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleUpdateBroadcast,
  });

  /**
   * DELETE /api/broadcasts/:id
   * Delete broadcast
   */
  fastify.delete('/:id', {
    schema: {
      description: 'Delete broadcast',
      tags: ['broadcasts'],
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
    handler: handleDeleteBroadcast,
  });

  /**
   * POST /api/broadcasts/:id/send
   * Send broadcast
   */
  fastify.post('/:id/send', {
    schema: {
      description: 'Send broadcast to audience',
      tags: ['broadcasts'],
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
                broadcastId: { type: 'string' },
                status: { type: 'string' },
                recipientsCount: { type: 'number' },
                message: { type: 'string' },
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
        502: {
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
    handler: handleSendBroadcast,
  });

  /**
   * POST /api/broadcasts/:id/preview
   * Preview broadcast
   */
  fastify.post('/:id/preview', {
    schema: {
      description: 'Send broadcast preview to admin',
      tags: ['broadcasts'],
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
        required: ['telegramId'],
        properties: {
          telegramId: { type: 'string' },
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
        403: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        502: {
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
    handler: handlePreviewBroadcast,
  });

  /**
   * GET /api/broadcasts/audience
   * Get audience count
   */
  fastify.get('/audience', {
    schema: {
      description: 'Get audience count for broadcast targeting',
      tags: ['broadcasts'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['audience'],
        properties: {
          audience: { type: 'string', enum: ['ALL', 'PLAN', 'SUBSCRIBED', 'UNSUBSCRIBED', 'EXPIRED', 'TRIAL'] },
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
                audience: { type: 'string' },
                planId: { type: 'string' },
                count: { type: 'number' },
              },
            },
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
        401: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    onRequest: [fastify.authenticate],
    handler: handleGetAudience,
  });
}
