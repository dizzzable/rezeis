/**
 * Notification entity
 */
export interface Notification {
  id: string;
  userId: string | null;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  linkUrl?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Notification type
 */
export type NotificationType =
  | 'system'
  | 'subscription'
  | 'payment'
  | 'promocode'
  | 'referral'
  | 'partner'
  | 'security'
  | 'announcement';

/**
 * Create notification DTO
 */
export interface CreateNotificationDto {
  userId?: string;
  type: NotificationType;
  title: string;
  message: string;
  linkUrl?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Update notification DTO
 */
export interface UpdateNotificationDto {
  isRead?: boolean;
  title?: string;
  message?: string;
  linkUrl?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Notification filters
 */
export interface NotificationFilters {
  userId?: string;
  type?: NotificationType;
  isRead?: boolean;
  search?: string;
}

/**
 * Notification count result
 */
export interface NotificationCountResult {
  userId?: string;
  total: number;
  unread: number;
  read: number;
  byType: Record<NotificationType, number>;
}

/**
 * Mark as read DTO
 */
export interface MarkAsReadDto {
  ids?: string[];
  all?: boolean;
  userId?: string;
}
