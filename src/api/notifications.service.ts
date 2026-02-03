import apiClient from './client';
import type { ApiResponse, PaginatedResult } from '../types/entity.types';

export type NotificationType =
  | 'system'
  | 'subscription'
  | 'payment'
  | 'promocode'
  | 'referral'
  | 'partner'
  | 'security'
  | 'announcement';

export interface Notification {
  id: string;
  userId: string | null;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  linkUrl: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationFilters {
  userId?: string;
  type?: NotificationType;
  isRead?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface CreateNotificationInput {
  userId?: string;
  type: NotificationType;
  title: string;
  message: string;
  linkUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateNotificationInput {
  isRead?: boolean;
}

export interface SendNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  linkUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface MarkAsReadInput {
  notificationIds?: string[];
  userId?: string;
  markAll?: boolean;
}

export interface NotificationStatistics {
  total: number;
  unread: number;
  read: number;
  byType: Record<string, number>;
}

/**
 * List notifications with filters and pagination
 * @param filters - Query parameters for filtering and pagination
 * @returns Promise with paginated notifications
 */
export async function listNotifications(
  filters: NotificationFilters = {}
): Promise<PaginatedResult<Notification>> {
  const params = new URLSearchParams();

  if (filters.userId) params.append('userId', filters.userId);
  if (filters.type) params.append('type', filters.type);
  if (filters.isRead !== undefined) params.append('isRead', String(filters.isRead));
  if (filters.page) params.append('page', String(filters.page));
  if (filters.limit) params.append('limit', String(filters.limit));
  if (filters.sortBy) params.append('sortBy', filters.sortBy);
  if (filters.sortOrder) params.append('sortOrder', filters.sortOrder);

  const response = await apiClient.get<ApiResponse<PaginatedResult<Notification>>>(
    `/api/notifications?${params.toString()}`
  );
  return response.data.data;
}

/**
 * Get notification by ID
 * @param id - Notification ID
 * @returns Promise with notification data
 */
export async function getNotification(id: string): Promise<Notification> {
  const response = await apiClient.get<ApiResponse<Notification>>(`/api/notifications/${id}`);
  return response.data.data;
}

/**
 * Get notifications for a specific user
 * @param userId - User ID
 * @returns Promise with paginated notifications
 */
export async function getUserNotifications(userId: string): Promise<PaginatedResult<Notification>> {
  const response = await apiClient.get<ApiResponse<PaginatedResult<Notification>>>(
    `/api/notifications/user/${userId}`
  );
  return response.data.data;
}

/**
 * Get unread notifications for a user
 * @param userId - User ID
 * @returns Promise with paginated notifications
 */
export async function getUnreadNotifications(userId: string): Promise<PaginatedResult<Notification>> {
  const response = await apiClient.get<ApiResponse<PaginatedResult<Notification>>>(
    `/api/notifications/user/${userId}/unread`
  );
  return response.data.data;
}

/**
 * Get unread notification count for a user
 * @param userId - User ID
 * @returns Promise with count
 */
export async function getUnreadCount(userId: string): Promise<number> {
  const response = await apiClient.get<ApiResponse<{ count: number }>>(
    `/api/notifications/user/${userId}/unread-count`
  );
  return response.data.data.count;
}

/**
 * Get notification statistics
 * @returns Promise with statistics
 */
export async function getStatistics(): Promise<NotificationStatistics> {
  const response = await apiClient.get<ApiResponse<NotificationStatistics>>(
    '/api/notifications/statistics'
  );
  return response.data.data;
}

/**
 * Get statistics for a specific user
 * @param userId - User ID
 * @returns Promise with statistics
 */
export async function getUserStatistics(userId: string): Promise<NotificationStatistics> {
  const response = await apiClient.get<ApiResponse<NotificationStatistics>>(
    `/api/notifications/user/${userId}/statistics`
  );
  return response.data.data;
}

/**
 * Create a new notification
 * @param input - Notification creation data
 * @returns Promise with created notification
 */
export async function createNotification(input: CreateNotificationInput): Promise<Notification> {
  const response = await apiClient.post<ApiResponse<Notification>>('/api/notifications', input);
  return response.data.data;
}

/**
 * Send a notification to a specific user
 * @param input - Send notification input
 * @returns Promise with created notification and message
 */
export async function sendNotification(
  input: SendNotificationInput
): Promise<{ notification: Notification; message: string }> {
  const response = await apiClient.post<ApiResponse<{ notification: Notification; message: string }>>(
    '/api/notifications/send',
    input
  );
  return response.data.data;
}

/**
 * Send a global notification to all users
 * @param input - Send notification input without userId
 * @returns Promise with created notification and message
 */
export async function sendGlobalNotification(
  input: Omit<SendNotificationInput, 'userId'>
): Promise<{ notification: Notification; message: string }> {
  const response = await apiClient.post<ApiResponse<{ notification: Notification; message: string }>>(
    '/api/notifications/send-global',
    input
  );
  return response.data.data;
}

/**
 * Update a notification
 * @param id - Notification ID
 * @param input - Update data
 * @returns Promise with updated notification
 */
export async function updateNotification(
  id: string,
  input: UpdateNotificationInput
): Promise<Notification> {
  const response = await apiClient.patch<ApiResponse<Notification>>(`/api/notifications/${id}`, input);
  return response.data.data;
}

/**
 * Mark notifications as read
 * @param input - Mark as read input
 * @returns Promise with count of marked notifications
 */
export async function markAsRead(input: MarkAsReadInput): Promise<number> {
  const response = await apiClient.post<ApiResponse<{ markedAsRead: number }>>(
    '/api/notifications/mark-read',
    input
  );
  return response.data.data.markedAsRead;
}

/**
 * Delete a notification
 * @param id - Notification ID
 * @returns Promise that resolves when notification is deleted
 */
export async function deleteNotification(id: string): Promise<void> {
  await apiClient.delete<ApiResponse<void>>(`/api/notifications/${id}`);
}

/**
 * Notifications service object
 */
export const notificationsService = {
  listNotifications,
  getNotification,
  getUserNotifications,
  getUnreadNotifications,
  getUnreadCount,
  getStatistics,
  getUserStatistics,
  createNotification,
  sendNotification,
  sendGlobalNotification,
  updateNotification,
  markAsRead,
  deleteNotification,
};
