import type { FastifyRequest, FastifyReply } from 'fastify';
import { NotificationService, NotificationServiceError } from './notification.service.js';
import type {
  CreateNotificationInput,
  UpdateNotificationInput,
  MarkAsReadInput,
  SendNotificationInput,
  ListNotificationsQuery,
} from './notification.schemas.js';
import { logger } from '../../utils/logger.js';

/**
 * Notification controller class
 * Handles HTTP requests for notification management
 */
export class NotificationController {
  constructor(private readonly service: NotificationService) {}

  /**
   * Handle list notifications request
   */
  handleListNotifications = async (
    request: FastifyRequest<{ Querystring: ListNotificationsQuery }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { page, limit, userId, type, isRead, search, sortBy, sortOrder } = request.query;

      const result = await this.service.getNotifications(
        { userId, type, isRead, search },
        { page, limit, sortBy, sortOrder }
      );

      reply.send({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to list notifications');
      reply.status(500).send({
        success: false,
        error: 'Failed to list notifications',
      });
    }
  };

  /**
   * Handle get notification by ID request
   */
  handleGetNotification = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { id } = request.params;
      const notification = await this.service.getNotificationById(id);

      if (!notification) {
        reply.status(404).send({
          success: false,
          error: 'Notification not found',
        });
        return;
      }

      reply.send({
        success: true,
        data: notification,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get notification');
      reply.status(500).send({
        success: false,
        error: 'Failed to get notification',
      });
    }
  };

  /**
   * Handle get notifications by user ID request
   */
  handleGetNotificationsByUser = async (
    request: FastifyRequest<{ Params: { userId: string }; Querystring: { page?: number; limit?: number } }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { userId } = request.params;
      const { page = 1, limit = 25 } = request.query;
      const result = await this.service.getNotificationsByUserId(userId, page, limit);

      reply.send({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get notifications by user');
      reply.status(500).send({
        success: false,
        error: 'Failed to get notifications by user',
      });
    }
  };

  /**
   * Handle get unread notifications by user ID request
   */
  handleGetUnreadNotifications = async (
    request: FastifyRequest<{ Params: { userId: string }; Querystring: { page?: number; limit?: number } }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { userId } = request.params;
      const { page = 1, limit = 25 } = request.query;
      const result = await this.service.getUnreadNotificationsByUserId(userId, page, limit);

      reply.send({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get unread notifications');
      reply.status(500).send({
        success: false,
        error: 'Failed to get unread notifications',
      });
    }
  };

  /**
   * Handle create notification request
   */
  handleCreateNotification = async (
    request: FastifyRequest<{ Body: CreateNotificationInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const notification = await this.service.createNotification(request.body);

      reply.status(201).send({
        success: true,
        data: notification,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to create notification');

      if (error instanceof NotificationServiceError) {
        reply.status(400).send({
          success: false,
          error: error.message,
        });
        return;
      }

      reply.status(500).send({
        success: false,
        error: 'Failed to create notification',
      });
    }
  };

  /**
   * Handle update notification request
   */
  handleUpdateNotification = async (
    request: FastifyRequest<{ Params: { id: string }; Body: UpdateNotificationInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { id } = request.params;
      const notification = await this.service.updateNotification(id, request.body);

      reply.send({
        success: true,
        data: notification,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to update notification');

      if (error instanceof NotificationServiceError) {
        const status = error.message.includes('not found') ? 404 : 400;
        reply.status(status).send({
          success: false,
          error: error.message,
        });
        return;
      }

      reply.status(500).send({
        success: false,
        error: 'Failed to update notification',
      });
    }
  };

  /**
   * Handle delete notification request
   */
  handleDeleteNotification = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { id } = request.params;
      await this.service.deleteNotification(id);

      reply.send({
        success: true,
        message: 'Notification deleted successfully',
      });
    } catch (error) {
      logger.error({ error }, 'Failed to delete notification');

      if (error instanceof NotificationServiceError) {
        const status = error.message.includes('not found') ? 404 : 500;
        reply.status(status).send({
          success: false,
          error: error.message,
        });
        return;
      }

      reply.status(500).send({
        success: false,
        error: 'Failed to delete notification',
      });
    }
  };

  /**
   * Handle mark as read request
   */
  handleMarkAsRead = async (
    request: FastifyRequest<{ Body: MarkAsReadInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { ids, all, userId } = request.body;

      let count: number;
      if (all && userId) {
        count = await this.service.markAllAsRead(userId);
      } else if (ids && ids.length > 0) {
        count = await this.service.markAsRead(ids, userId);
      } else {
        reply.status(400).send({
          success: false,
          error: 'Either ids or all with userId must be provided',
        });
        return;
      }

      reply.send({
        success: true,
        data: { markedAsRead: count },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to mark notifications as read');
      reply.status(500).send({
        success: false,
        error: 'Failed to mark notifications as read',
      });
    }
  };

  /**
   * Handle get statistics request
   */
  handleGetStatistics = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    void request;
    try {
      const stats = await this.service.getStatistics();

      reply.send({
        success: true,
        data: stats,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get notification statistics');
      reply.status(500).send({
        success: false,
        error: 'Failed to get statistics',
      });
    }
  };

  /**
   * Handle get user statistics request
   */
  handleGetUserStatistics = async (
    request: FastifyRequest<{ Params: { userId: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { userId } = request.params;
      const stats = await this.service.getUserStatistics(userId);

      reply.send({
        success: true,
        data: stats,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get user notification statistics');
      reply.status(500).send({
        success: false,
        error: 'Failed to get user statistics',
      });
    }
  };

  /**
   * Handle get unread count request
   */
  handleGetUnreadCount = async (
    request: FastifyRequest<{ Params: { userId: string } }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { userId } = request.params;
      const count = await this.service.countUnreadByUserId(userId);

      reply.send({
        success: true,
        data: { count },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get unread count');
      reply.status(500).send({
        success: false,
        error: 'Failed to get unread count',
      });
    }
  };

  /**
   * Handle send notification request
   */
  handleSendNotification = async (
    request: FastifyRequest<{ Body: SendNotificationInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const notification = await this.service.sendNotification(request.body);

      reply.status(201).send({
        success: true,
        data: notification,
        message: 'Notification sent successfully',
      });
    } catch (error) {
      logger.error({ error }, 'Failed to send notification');

      if (error instanceof NotificationServiceError) {
        reply.status(400).send({
          success: false,
          error: error.message,
        });
        return;
      }

      reply.status(500).send({
        success: false,
        error: 'Failed to send notification',
      });
    }
  };

  /**
   * Handle send global notification request
   */
  handleSendGlobalNotification = async (
    request: FastifyRequest<{ Body: SendNotificationInput }>,
    reply: FastifyReply
  ): Promise<void> => {
    try {
      const { type, title, message, linkUrl, metadata } = request.body;
      const notification = await this.service.sendGlobalNotification(
        type,
        title,
        message,
        linkUrl,
        metadata
      );

      reply.status(201).send({
        success: true,
        data: notification,
        message: 'Global notification sent successfully',
      });
    } catch (error) {
      logger.error({ error }, 'Failed to send global notification');

      if (error instanceof NotificationServiceError) {
        reply.status(400).send({
          success: false,
          error: error.message,
        });
        return;
      }

      reply.status(500).send({
        success: false,
        error: 'Failed to send global notification',
      });
    }
  };
}
