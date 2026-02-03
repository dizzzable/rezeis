import { z } from 'zod';

/**
 * Notification type enum
 */
export const notificationTypeSchema = z.enum([
  'system',
  'subscription',
  'payment',
  'promocode',
  'referral',
  'partner',
  'security',
  'announcement',
]);

/**
 * Notification ID parameter schema
 */
export const notificationIdParamSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Create notification schema
 */
export const createNotificationSchema = z.object({
  userId: z.string().uuid().optional(),
  type: notificationTypeSchema,
  title: z.string().min(1).max(255),
  message: z.string().min(1),
  linkUrl: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Update notification schema (mark as read)
 */
export const updateNotificationSchema = z.object({
  isRead: z.boolean(),
});

/**
 * Mark as read schema
 */
export const markAsReadSchema = z.object({
  ids: z.array(z.string().uuid()).optional(),
  all: z.boolean().optional(),
  userId: z.string().uuid().optional(),
});

/**
 * Send notification schema
 */
export const sendNotificationSchema = z.object({
  userId: z.string().uuid().optional(),
  type: notificationTypeSchema,
  title: z.string().min(1).max(255),
  message: z.string().min(1),
  linkUrl: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Query parameters for listing notifications
 */
export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  userId: z.string().uuid().optional(),
  type: notificationTypeSchema.optional(),
  isRead: z.coerce.boolean().optional(),
  search: z.string().optional(),
  sortBy: z.enum(['created_at', 'updated_at']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Notification response schema
 */
export const notificationResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  type: notificationTypeSchema,
  title: z.string(),
  message: z.string(),
  isRead: z.boolean(),
  linkUrl: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Paginated notifications response schema
 */
export const paginatedNotificationsResponseSchema = z.object({
  data: z.array(notificationResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
  totalPages: z.number(),
});

/**
 * Notification statistics schema
 */
export const notificationStatisticsSchema = z.object({
  total: z.number(),
  unread: z.number(),
  read: z.number(),
  byType: z.record(z.string(), z.number()),
});

/**
 * Unread count response schema
 */
export const unreadCountResponseSchema = z.object({
  count: z.number(),
});

// Type inference
export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;
export type UpdateNotificationInput = z.infer<typeof updateNotificationSchema>;
export type MarkAsReadInput = z.infer<typeof markAsReadSchema>;
export type SendNotificationInput = z.infer<typeof sendNotificationSchema>;
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
export type NotificationType = z.infer<typeof notificationTypeSchema>;
