/**
 * Notification Service
 * Handles business logic for notifications, separating API calls from state management
 */

import {
  getNotifications,
  markNotificationAsRead,
} from '@/api/client.service';
import {
  markAsRead as markNotificationsAsRead,
  deleteNotification as deleteNotificationApi,
} from '@/api/notifications.service';
import type { NotificationType as StoreNotificationType } from '@/stores/notification.store';

/**
 * Backend notification type
 */
export interface BackendNotification {
  id: string;
  type: StoreNotificationType;
  title: string;
  message: string;
  timestamp: Date;
  persistent?: boolean;
}

/**
 * Pagination options for fetching notifications
 */
export interface FetchNotificationsOptions {
  page?: number;
  limit?: number;
  unreadOnly?: boolean;
}

/**
 * Fetch notifications from API
 * @param options - Pagination and filter options
 * @returns Promise with array of notifications
 */
export async function fetchNotifications(
  options: FetchNotificationsOptions = {}
): Promise<BackendNotification[]> {
  const { page = 1, limit = 10, unreadOnly = false } = options;
  const response = await getNotifications(page, limit, unreadOnly);

  return response.items.map((item) => ({
    id: String(item.id),
    type: (item.type || 'info') as StoreNotificationType,
    title: item.title,
    message: item.message,
    timestamp: new Date(item.createdAt),
    persistent: false,
  }));
}

/**
 * Mark a single notification as read
 * @param notificationId - ID of the notification to mark as read
 * @returns Promise with success status
 */
export async function markAsRead(notificationId: string): Promise<boolean> {
  const response = await markNotificationAsRead(Number(notificationId));
  return response.success;
}

/**
 * Mark all notifications as read
 * @returns Promise with count of marked notifications
 */
export async function markAllAsRead(): Promise<number> {
  const response = await markNotificationsAsRead({ markAll: true });
  return response;
}

/**
 * Delete a notification
 * @param notificationId - ID of the notification to delete
 * @returns Promise that resolves when deleted
 */
export async function deleteNotification(notificationId: string): Promise<void> {
  await deleteNotificationApi(notificationId);
}

/**
 * Get count of unread notifications
 * @returns Promise with unread count
 */
export async function getUnreadCount(): Promise<number> {
  // Get from admin notifications API - this gets the current user's unread count
  // We need to pass a userId, but for client notifications, the backend
  // should infer it from the authenticated user
  // Fallback to getNotifications and count unread
  const response = await getNotifications(1, 1, true);
  return response.unreadCount;
}

/**
 * Notification service object with all methods
 */
export const notificationService = {
  fetchNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  getUnreadCount,
};

export default notificationService;
