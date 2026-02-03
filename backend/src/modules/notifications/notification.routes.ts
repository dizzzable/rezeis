import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { getPool } from '../../config/database.js';
import { NotificationRepository } from '../../repositories/notification.repository.js';
import { NotificationService } from './notification.service.js';
import { NotificationController } from './notification.controller.js';
import {
  createNotificationSchema,
  updateNotificationSchema,
  markAsReadSchema,
  sendNotificationSchema,
  listNotificationsQuerySchema,
  notificationIdParamSchema,
  notificationResponseSchema,
  paginatedNotificationsResponseSchema,
  notificationStatisticsSchema,
  unreadCountResponseSchema,
} from './notification.schemas.js';

/**
 * Configure notification routes
 */
export async function notificationRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions
): Promise<void> {
  void options;
  const pool = getPool();
  const repository = new NotificationRepository(pool);
  const service = new NotificationService(repository);
  const controller = new NotificationController(service);

  // GET /notifications - List all notifications
  fastify.get('/', {
    schema: {
      tags: ['notifications'],
      summary: 'List all notifications',
      description: 'Get paginated list of notifications with filters',
      querystring: listNotificationsQuerySchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: paginatedNotificationsResponseSchema,
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleListNotifications,
  });

  // GET /notifications/statistics - Get statistics
  fastify.get('/statistics', {
    schema: {
      tags: ['notifications'],
      summary: 'Get notification statistics',
      description: 'Get statistics about notifications',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: notificationStatisticsSchema,
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleGetStatistics,
  });

  // GET /notifications/user/:userId - Get user notifications
  fastify.get('/user/:userId', {
    schema: {
      tags: ['notifications'],
      summary: 'Get user notifications',
      description: 'Get all notifications for a specific user',
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
            data: paginatedNotificationsResponseSchema,
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleGetNotificationsByUser,
  });

  // GET /notifications/user/:userId/unread - Get user unread notifications
  fastify.get('/user/:userId/unread', {
    schema: {
      tags: ['notifications'],
      summary: 'Get user unread notifications',
      description: 'Get unread notifications for a specific user',
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
            data: paginatedNotificationsResponseSchema,
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleGetUnreadNotifications,
  });

  // GET /notifications/user/:userId/unread-count - Get unread count
  fastify.get('/user/:userId/unread-count', {
    schema: {
      tags: ['notifications'],
      summary: 'Get unread notification count',
      description: 'Get count of unread notifications for a user',
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
            data: unreadCountResponseSchema,
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleGetUnreadCount,
  });

  // GET /notifications/user/:userId/statistics - Get user statistics
  fastify.get('/user/:userId/statistics', {
    schema: {
      tags: ['notifications'],
      summary: 'Get user notification statistics',
      description: 'Get statistics about user notifications',
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
            data: notificationStatisticsSchema,
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleGetUserStatistics,
  });

  // GET /notifications/:id - Get notification by ID
  fastify.get('/:id', {
    schema: {
      tags: ['notifications'],
      summary: 'Get notification by ID',
      description: 'Get a single notification by its ID',
      params: notificationIdParamSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: notificationResponseSchema,
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
    handler: controller.handleGetNotification,
  });

  // POST /notifications - Create new notification
  fastify.post('/', {
    schema: {
      tags: ['notifications'],
      summary: 'Create notification',
      description: 'Create a new notification',
      body: createNotificationSchema,
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: notificationResponseSchema,
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
    handler: controller.handleCreateNotification,
  });

  // POST /notifications/send - Send notification to user
  fastify.post('/send', {
    schema: {
      tags: ['notifications'],
      summary: 'Send notification',
      description: 'Send a notification to a specific user',
      body: sendNotificationSchema,
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: notificationResponseSchema,
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
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleSendNotification,
  });

  // POST /notifications/send-global - Send global notification
  fastify.post('/send-global', {
    schema: {
      tags: ['notifications'],
      summary: 'Send global notification',
      description: 'Send a global notification to all users',
      body: sendNotificationSchema,
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: notificationResponseSchema,
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
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleSendGlobalNotification,
  });

  // PATCH /notifications/:id - Update notification
  fastify.patch('/:id', {
    schema: {
      tags: ['notifications'],
      summary: 'Update notification',
      description: 'Update an existing notification (mark as read)',
      params: notificationIdParamSchema,
      body: updateNotificationSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: notificationResponseSchema,
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
    handler: controller.handleUpdateNotification,
  });

  // POST /notifications/mark-read - Mark notifications as read
  fastify.post('/mark-read', {
    schema: {
      tags: ['notifications'],
      summary: 'Mark notifications as read',
      description: 'Mark specific notifications or all as read',
      body: markAsReadSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                markedAsRead: { type: 'number' },
              },
            },
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    onRequest: [fastify.authenticate],
    handler: controller.handleMarkAsRead,
  });

  // DELETE /notifications/:id - Delete notification
  fastify.delete('/:id', {
    schema: {
      tags: ['notifications'],
      summary: 'Delete notification',
      description: 'Delete a notification by ID',
      params: notificationIdParamSchema,
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
    handler: controller.handleDeleteNotification,
  });
}
