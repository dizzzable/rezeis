import { z } from 'zod';

/**
 * Multisubscription ID parameter schema
 */
export const multisubscriptionIdParamSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Create multisubscription schema
 */
export const createMultisubscriptionSchema = z.object({
  userId: z.string().uuid(),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  subscriptionIds: z.array(z.string().uuid()).default([]),
  isActive: z.boolean().default(true),
});

/**
 * Update multisubscription schema
 */
export const updateMultisubscriptionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  subscriptionIds: z.array(z.string().uuid()).optional(),
  isActive: z.boolean().optional(),
});

/**
 * Toggle multisubscription status schema
 */
export const toggleMultisubscriptionSchema = z.object({
  isActive: z.boolean(),
});

/**
 * Query parameters for listing multisubscriptions
 */
export const listMultisubscriptionsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  userId: z.string().uuid().optional(),
  isActive: z.coerce.boolean().optional(),
  search: z.string().optional(),
  sortBy: z.enum(['created_at', 'name', 'updated_at']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Multisubscription response schema
 */
export const multisubscriptionResponseSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  subscriptionIds: z.array(z.string().uuid()),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Paginated multisubscriptions response schema
 */
export const paginatedMultisubscriptionsResponseSchema = z.object({
  data: z.array(multisubscriptionResponseSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
  totalPages: z.number(),
});

/**
 * Multisubscription statistics schema
 */
export const multisubscriptionStatisticsSchema = z.object({
  total: z.number(),
  active: z.number(),
  inactive: z.number(),
});

// Type inference
export type CreateMultisubscriptionInput = z.infer<typeof createMultisubscriptionSchema>;
export type UpdateMultisubscriptionInput = z.infer<typeof updateMultisubscriptionSchema>;
export type ToggleMultisubscriptionInput = z.infer<typeof toggleMultisubscriptionSchema>;
export type ListMultisubscriptionsQuery = z.infer<typeof listMultisubscriptionsQuerySchema>;
