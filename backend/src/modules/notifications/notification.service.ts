import type { NotificationRepository } from '../../repositories/notification.repository.js';
import type {
  Notification,
  CreateNotificationDto,
  UpdateNotificationDto,
  NotificationFilters,
} from '../../entities/notification.entity.js';
import { logger } from '../../utils/logger.js';

/**
 * Notification service error class
 */
export class NotificationServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'NotificationServiceError';
  }
}

/**
 * Pagination options interface
 */
interface PaginationOptions {
  page: number;
  limit: number;
  sortBy?: 'created_at' | 'updated_at';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated result interface
 */
interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Notification service class
 * Handles business logic for notification management
 */
export class NotificationService {
  constructor(private readonly repository: NotificationRepository) {}

  /**
   * Get all notifications with pagination and filters
   */
  async getNotifications(
    filters: NotificationFilters,
    options: PaginationOptions
  ): Promise<PaginatedResult<Notification>> {
    try {
      const { page, limit, sortBy = 'created_at', sortOrder = 'desc' } = options;
      const result = await this.repository.findWithFilters(filters, page, limit, sortBy, sortOrder);
      return {
        ...result,
        page,
        limit,
        totalPages: Math.ceil(result.total / limit),
      };
    } catch (error) {
      logger.error({ error, filters }, 'Failed to get notifications');
      throw new NotificationServiceError('Failed to get notifications', error);
    }
  }

  /**
   * Get notification by ID
   */
  async getNotificationById(id: string): Promise<Notification | null> {
    try {
      return await this.repository.findById(id);
    } catch (error) {
      logger.error({ error, id }, 'Failed to get notification by ID');
      throw new NotificationServiceError('Failed to get notification by ID', error);
    }
  }

  /**
   * Get notifications by user ID
   */
  async getNotificationsByUserId(
    userId: string,
    page = 1,
    limit = 25
  ): Promise<PaginatedResult<Notification>> {
    try {
      const result = await this.repository.findByUserId(userId, page, limit);
      return {
        ...result,
        page,
        limit,
        totalPages: Math.ceil(result.total / limit),
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get notifications by user ID');
      throw new NotificationServiceError('Failed to get notifications by user ID', error);
    }
  }

  /**
   * Get unread notifications by user ID
   */
  async getUnreadNotificationsByUserId(
    userId: string,
    page = 1,
    limit = 25
  ): Promise<PaginatedResult<Notification>> {
    try {
      const result = await this.repository.findUnreadByUserId(userId, page, limit);
      return {
        ...result,
        page,
        limit,
        totalPages: Math.ceil(result.total / limit),
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get unread notifications');
      throw new NotificationServiceError('Failed to get unread notifications', error);
    }
  }

  /**
   * Create new notification
   */
  async createNotification(data: CreateNotificationDto): Promise<Notification> {
    try {
      return await this.repository.create(data);
    } catch (error) {
      logger.error({ error, data }, 'Failed to create notification');
      throw new NotificationServiceError('Failed to create notification', error);
    }
  }

  /**
   * Update notification
   */
  async updateNotification(id: string, data: UpdateNotificationDto): Promise<Notification> {
    try {
      const existing = await this.repository.findById(id);
      if (!existing) {
        throw new NotificationServiceError('Notification not found');
      }
      return await this.repository.update(id, data);
    } catch (error) {
      logger.error({ error, id, data }, 'Failed to update notification');
      throw new NotificationServiceError('Failed to update notification', error);
    }
  }

  /**
   * Delete notification
   */
  async deleteNotification(id: string): Promise<void> {
    try {
      const existing = await this.repository.findById(id);
      if (!existing) {
        throw new NotificationServiceError('Notification not found');
      }
      const deleted = await this.repository.delete(id);
      if (!deleted) {
        throw new NotificationServiceError('Failed to delete notification');
      }
    } catch (error) {
      logger.error({ error, id }, 'Failed to delete notification');
      throw new NotificationServiceError('Failed to delete notification', error);
    }
  }

  /**
   * Mark notifications as read
   */
  async markAsRead(ids: string[], userId?: string): Promise<number> {
    try {
      return await this.repository.markAsRead(ids, userId);
    } catch (error) {
      logger.error({ error, ids, userId }, 'Failed to mark notifications as read');
      throw new NotificationServiceError('Failed to mark notifications as read', error);
    }
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string): Promise<number> {
    try {
      return await this.repository.markAllAsRead(userId);
    } catch (error) {
      logger.error({ error, userId }, 'Failed to mark all notifications as read');
      throw new NotificationServiceError('Failed to mark all notifications as read', error);
    }
  }

  /**
   * Count unread notifications for a user
   */
  async countUnreadByUserId(userId: string): Promise<number> {
    try {
      return await this.repository.countUnreadByUserId(userId);
    } catch (error) {
      logger.error({ error, userId }, 'Failed to count unread notifications');
      throw new NotificationServiceError('Failed to count unread notifications', error);
    }
  }

  /**
   * Get notification statistics
   */
  async getStatistics(): Promise<{
    total: number;
    unread: number;
    read: number;
    byType: Record<string, number>;
  }> {
    try {
      return await this.repository.getStatistics();
    } catch (error) {
      logger.error({ error }, 'Failed to get notification statistics');
      throw new NotificationServiceError('Failed to get notification statistics', error);
    }
  }

  /**
   * Get user notification statistics
   */
  async getUserStatistics(userId: string): Promise<{
    total: number;
    unread: number;
    read: number;
    byType: Record<string, number>;
  }> {
    try {
      return await this.repository.getUserStatistics(userId);
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get user notification statistics');
      throw new NotificationServiceError('Failed to get user notification statistics', error);
    }
  }

  /**
   * Send notification to user
   */
  async sendNotification(data: CreateNotificationDto): Promise<Notification> {
    try {
      return await this.repository.create(data);
    } catch (error) {
      logger.error({ error, data }, 'Failed to send notification');
      throw new NotificationServiceError('Failed to send notification', error);
    }
  }

  /**
   * Send global notification (to all users)
   */
  async sendGlobalNotification(
    type: Notification['type'],
    title: string,
    message: string,
    linkUrl?: string,
    metadata?: Record<string, unknown>
  ): Promise<Notification> {
    try {
      return await this.repository.create({
        userId: '',
        type,
        title,
        message,
        linkUrl,
        metadata,
      });
    } catch (error) {
      logger.error({ error, type, title }, 'Failed to send global notification');
      throw new NotificationServiceError('Failed to send global notification', error);
    }
  }

  /**
   * Cleanup old read notifications
   */
  async cleanupOldNotifications(days: number): Promise<number> {
    try {
      return await this.repository.deleteOldReadNotifications(days);
    } catch (error) {
      logger.error({ error, days }, 'Failed to cleanup old notifications');
      throw new NotificationServiceError('Failed to cleanup old notifications', error);
    }
  }
}
