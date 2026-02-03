import { z } from 'zod';

/**
 * Subscription status enum
 */
export const subscriptionStatusSchema = z.enum(['active', 'expired', 'cancelled', 'pending']);

/**
 * Subscription response schema
 */
export const subscriptionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  planId: z.string(),
  status: subscriptionStatusSchema,
  startDate: z.string(),
  endDate: z.string(),
  remnawaveUuid: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Create subscription schema
 */
export const createSubscriptionSchema = z.object({
  userId: z.string(),
  planId: z.string(),
  status: subscriptionStatusSchema.default('active'),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  remnawaveUuid: z.string().optional(),
});

/**
 * Update subscription schema
 */
export const updateSubscriptionSchema = z.object({
  planId: z.string().optional(),
  status: subscriptionStatusSchema.optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  remnawaveUuid: z.string().optional(),
});

/**
 * Get subscriptions query params schema
 */
export const getSubscriptionsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  status: subscriptionStatusSchema.optional(),
  userId: z.string().optional(),
  planId: z.string().optional(),
});

/**
 * Subscription params schema
 */
export const subscriptionParamsSchema = z.object({
  id: z.string(),
});

/**
 * Expiring subscriptions query schema
 */
export const expiringSubscriptionsQuerySchema = z.object({
  days: z.coerce.number().min(1).max(90).default(7),
});

/**
 * Paginated subscriptions response schema
 */
export const paginatedSubscriptionsResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    data: z.array(subscriptionSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
  }),
  message: z.string().optional(),
});

/**
 * Subscription response wrapper schema
 */
export const subscriptionResponseSchema = z.object({
  success: z.boolean(),
  data: subscriptionSchema,
  message: z.string().optional(),
});

/**
 * Type definitions
 */
export type SubscriptionResponse = z.infer<typeof subscriptionSchema>;
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;
export type GetSubscriptionsQuery = z.infer<typeof getSubscriptionsQuerySchema>;
export type SubscriptionParams = z.infer<typeof subscriptionParamsSchema>;
export type ExpiringSubscriptionsQuery = z.infer<typeof expiringSubscriptionsQuerySchema>;
