import { z } from 'zod';

/**
 * Broadcast audience enum schema
 */
export const broadcastAudienceSchema = z.enum(['ALL', 'PLAN', 'SUBSCRIBED', 'UNSUBSCRIBED', 'EXPIRED', 'TRIAL']);

/**
 * Broadcast status enum schema
 */
export const broadcastStatusSchema = z.enum(['draft', 'pending', 'sending', 'completed', 'failed']);

/**
 * Broadcast button type enum schema
 */
export const broadcastButtonTypeSchema = z.enum(['url', 'goto']);

/**
 * Broadcast button schema
 */
export const broadcastButtonSchema = z.object({
  id: z.string(),
  broadcastId: z.string(),
  text: z.string(),
  type: broadcastButtonTypeSchema,
  value: z.string(),
  createdAt: z.string(),
});

/**
 * Broadcast schema
 */
export const broadcastSchema = z.object({
  id: z.string(),
  audience: broadcastAudienceSchema,
  planId: z.string().optional(),
  content: z.string(),
  mediaUrl: z.string().optional(),
  mediaType: z.enum(['photo', 'video']).optional(),
  status: broadcastStatusSchema,
  recipientsCount: z.number(),
  sentCount: z.number(),
  failedCount: z.number(),
  createdBy: z.string(),
  createdAt: z.string(),
  sentAt: z.string().optional(),
  errorMessage: z.string().optional(),
});

/**
 * Broadcast with buttons schema
 */
export const broadcastWithButtonsSchema = broadcastSchema.extend({
  buttons: z.array(broadcastButtonSchema),
});

/**
 * Create broadcast button schema
 */
export const createBroadcastButtonSchema = z.object({
  text: z.string().min(1).max(100),
  type: broadcastButtonTypeSchema,
  value: z.string().min(1).max(500),
});

/**
 * Create broadcast schema
 */
export const createBroadcastSchema = z.object({
  audience: broadcastAudienceSchema,
  planId: z.string().uuid().optional(),
  content: z.string().min(1).max(4000),
  mediaUrl: z.string().url().max(500).optional(),
  mediaType: z.enum(['photo', 'video']).optional(),
  buttons: z.array(createBroadcastButtonSchema).max(3).default([]),
});

/**
 * Update broadcast schema
 */
export const updateBroadcastSchema = z.object({
  audience: broadcastAudienceSchema.optional(),
  planId: z.string().uuid().optional(),
  content: z.string().min(1).max(4000).optional(),
  mediaUrl: z.string().url().max(500).optional(),
  mediaType: z.enum(['photo', 'video']).optional(),
  buttons: z.array(createBroadcastButtonSchema).max(3).optional(),
});

/**
 * Get broadcasts query schema
 */
export const getBroadcastsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  status: broadcastStatusSchema.optional(),
  audience: broadcastAudienceSchema.optional(),
});

/**
 * Broadcast params schema (for routes with ID)
 */
export const broadcastParamsSchema = z.object({
  id: z.string(),
});

/**
 * Get audience query schema
 */
export const getAudienceQuerySchema = z.object({
  audience: broadcastAudienceSchema,
  planId: z.string().uuid().optional(),
});

/**
 * Audience count response schema
 */
export const audienceCountResponseSchema = z.object({
  audience: broadcastAudienceSchema,
  planId: z.string().optional(),
  count: z.number(),
});

/**
 * Paginated broadcasts response schema
 */
export const paginatedBroadcastsResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    data: z.array(broadcastSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
  }),
  message: z.string().optional(),
});

/**
 * Broadcast response wrapper schema
 */
export const broadcastResponseSchema = z.object({
  success: z.boolean(),
  data: broadcastSchema,
  message: z.string().optional(),
});

/**
 * Broadcast with buttons response schema
 */
export const broadcastWithButtonsResponseSchema = z.object({
  success: z.boolean(),
  data: broadcastWithButtonsSchema,
  message: z.string().optional(),
});

/**
 * Audience response schema
 */
export const audienceResponseSchema = z.object({
  success: z.boolean(),
  data: audienceCountResponseSchema,
  message: z.string().optional(),
});

/**
 * Delete broadcast response schema
 */
export const deleteBroadcastResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

/**
 * Send broadcast response schema
 */
export const sendBroadcastResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    broadcastId: z.string(),
    status: broadcastStatusSchema,
    recipientsCount: z.number(),
    message: z.string(),
  }),
  message: z.string().optional(),
});

/**
 * Preview broadcast request schema
 */
export const previewBroadcastRequestSchema = z.object({
  telegramId: z.string(),
});

/**
 * Error response schema
 */
export const errorResponseSchema = z.object({
  success: z.boolean().optional(),
  error: z.string(),
});

/**
 * Type definitions
 */
export type BroadcastResponse = z.infer<typeof broadcastSchema>;
export type BroadcastWithButtonsResponse = z.infer<typeof broadcastWithButtonsSchema>;
export type BroadcastStatus = z.infer<typeof broadcastStatusSchema>;
export type BroadcastAudience = z.infer<typeof broadcastAudienceSchema>;
export type CreateBroadcastInput = z.infer<typeof createBroadcastSchema>;
export type UpdateBroadcastInput = z.infer<typeof updateBroadcastSchema>;
export type GetBroadcastsQuery = z.infer<typeof getBroadcastsQuerySchema>;
export type BroadcastParams = z.infer<typeof broadcastParamsSchema>;
export type GetAudienceQuery = z.infer<typeof getAudienceQuerySchema>;
export type AudienceCountResponse = z.infer<typeof audienceCountResponseSchema>;
export type CreateBroadcastButtonInput = z.infer<typeof createBroadcastButtonSchema>;
export type PreviewBroadcastRequest = z.infer<typeof previewBroadcastRequestSchema>;
