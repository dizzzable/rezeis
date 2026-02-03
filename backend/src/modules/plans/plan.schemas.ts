import { z } from 'zod';

/**
 * Plan response schema
 */
export const planSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  price: z.number(),
  durationDays: z.number(),
  trafficLimit: z.number().optional(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Create plan schema
 */
export const createPlanSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  price: z.number().min(0, 'Price must be non-negative'),
  durationDays: z.number().min(1, 'Duration must be at least 1 day'),
  trafficLimit: z.number().optional(),
  isActive: z.boolean().default(true),
});

/**
 * Update plan schema
 */
export const updatePlanSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  price: z.number().min(0).optional(),
  durationDays: z.number().min(1).optional(),
  trafficLimit: z.number().optional(),
  isActive: z.boolean().optional(),
});

/**
 * Plan params schema
 */
export const planParamsSchema = z.object({
  id: z.string(),
});

/**
 * Paginated plans response schema
 */
export const paginatedPlansResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    data: z.array(planSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
  }),
  message: z.string().optional(),
});

/**
 * Plan response wrapper schema
 */
export const planResponseSchema = z.object({
  success: z.boolean(),
  data: planSchema,
  message: z.string().optional(),
});

/**
 * Plans list response schema
 */
export const plansListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(planSchema),
  message: z.string().optional(),
});

/**
 * Type definitions
 */
export type PlanResponse = z.infer<typeof planSchema>;
export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
export type PlanParams = z.infer<typeof planParamsSchema>;
