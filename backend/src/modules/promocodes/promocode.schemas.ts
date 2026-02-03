import { z } from 'zod';

/**
 * Promocode reward type enum schema
 */
export const rewardTypeSchema = z.enum([
  'duration',
  'traffic',
  'devices',
  'subscription',
  'personal_discount',
  'purchase_discount',
]);

/**
 * Promocode availability enum schema
 */
export const availabilitySchema = z.enum(['all', 'new', 'existing', 'invited', 'allowed']);

/**
 * Promocode response schema
 */
export const promocodeSchema = z.object({
  id: z.string(),
  code: z.string(),
  description: z.string().optional(),
  rewardType: rewardTypeSchema,
  rewardValue: z.number().optional(),
  rewardPlanId: z.string().optional(),
  availability: availabilitySchema,
  allowedUserIds: z.array(z.string()),
  maxUses: z.number(),
  usedCount: z.number(),
  maxUsesPerUser: z.number(),
  startsAt: z.string().optional(),
  expiresAt: z.string().optional(),
  isActive: z.boolean(),
  createdBy: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Create promocode schema
 */
export const createPromocodeSchema = z.object({
  code: z.string().min(1, 'Code is required').max(50, 'Code must be at most 50 characters'),
  description: z.string().optional(),
  rewardType: rewardTypeSchema,
  rewardValue: z.number().optional(),
  rewardPlanId: z.string().optional(),
  availability: availabilitySchema.default('all'),
  allowedUserIds: z.array(z.string()).default([]),
  maxUses: z.number().default(-1),
  maxUsesPerUser: z.number().default(1),
  startsAt: z.string().optional(),
  expiresAt: z.string().optional(),
  isActive: z.boolean().default(true),
});

/**
 * Update promocode schema
 */
export const updatePromocodeSchema = z.object({
  code: z.string().min(1).max(50).optional(),
  description: z.string().optional(),
  rewardType: rewardTypeSchema.optional(),
  rewardValue: z.number().optional(),
  rewardPlanId: z.string().optional(),
  availability: availabilitySchema.optional(),
  allowedUserIds: z.array(z.string()).optional(),
  maxUses: z.number().optional(),
  maxUsesPerUser: z.number().optional(),
  startsAt: z.string().optional(),
  expiresAt: z.string().optional(),
  isActive: z.boolean().optional(),
});

/**
 * Promocode params schema
 */
export const promocodeParamsSchema = z.object({
  id: z.string(),
});

/**
 * Validate promocode schema
 */
export const validatePromocodeSchema = z.object({
  code: z.string(),
});

/**
 * Paginated promocodes response schema
 */
export const paginatedPromocodesResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    data: z.array(promocodeSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
  }),
  message: z.string().optional(),
});

/**
 * Promocode response wrapper schema
 */
export const promocodeResponseSchema = z.object({
  success: z.boolean(),
  data: promocodeSchema,
  message: z.string().optional(),
});

/**
 * Promocodes list response schema
 */
export const promocodesListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(promocodeSchema),
  message: z.string().optional(),
});

/**
 * Validate promocode response schema
 */
export const validatePromocodeResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    valid: z.boolean(),
    promocode: promocodeSchema.optional(),
  }),
  message: z.string().optional(),
});

/**
 * Type definitions
 */
export type PromocodeResponse = z.infer<typeof promocodeSchema>;
export type CreatePromocodeInput = z.infer<typeof createPromocodeSchema>;
export type UpdatePromocodeInput = z.infer<typeof updatePromocodeSchema>;
export type PromocodeParams = z.infer<typeof promocodeParamsSchema>;
export type ValidatePromocodeInput = z.infer<typeof validatePromocodeSchema>;
export type RewardType = z.infer<typeof rewardTypeSchema>;
export type AvailabilityType = z.infer<typeof availabilitySchema>;
