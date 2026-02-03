import { z } from 'zod';

/**
 * Referral ID params schema
 */
export const referralParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

/**
 * Create referral schema
 */
export const createReferralSchema = {
  type: 'object',
  required: ['referrerId', 'referredId'],
  properties: {
    referrerId: { type: 'string', format: 'uuid' },
    referredId: { type: 'string', format: 'uuid' },
    referralCode: { type: 'string' },
    ruleId: { type: 'string', format: 'uuid' },
    referrerReward: { type: 'number', minimum: 0 },
    referredReward: { type: 'number', minimum: 0 },
    notes: { type: 'string' },
  },
} as const;

/**
 * Update referral schema
 */
export const updateReferralSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['active', 'completed', 'cancelled'] },
    cancelledReason: { type: 'string' },
    notes: { type: 'string' },
  },
} as const;

/**
 * Referral filters schema
 */
export const referralFiltersSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['active', 'completed', 'cancelled'] },
    referrerId: { type: 'string', format: 'uuid' },
    referredId: { type: 'string', format: 'uuid' },
    page: { type: 'number', minimum: 1, default: 1 },
    limit: { type: 'number', minimum: 1, maximum: 100, default: 10 },
    sortBy: { type: 'string', default: 'createdAt' },
    sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
  },
} as const;

/**
 * Create rule schema
 */
export const createRuleSchema = {
  type: 'object',
  required: ['name', 'type', 'referrerReward', 'referredReward'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    type: { type: 'string', enum: ['first_purchase', 'cumulative', 'subscription'] },
    referrerReward: { type: 'number', minimum: 0 },
    referredReward: { type: 'number', minimum: 0 },
    minPurchaseAmount: { type: 'number', minimum: 0 },
    isActive: { type: 'boolean', default: true },
  },
} as const;

/**
 * Update rule schema
 */
export const updateRuleSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    type: { type: 'string', enum: ['first_purchase', 'cumulative', 'subscription'] },
    referrerReward: { type: 'number', minimum: 0 },
    referredReward: { type: 'number', minimum: 0 },
    minPurchaseAmount: { type: 'number', minimum: 0 },
    isActive: { type: 'boolean' },
  },
} as const;

/**
 * Referral response schema
 */
export const referralResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    referrerId: { type: 'string' },
    referredId: { type: 'string' },
    referralCode: { type: 'string' },
    status: { type: 'string' },
    referrerReward: { type: 'number' },
    referredReward: { type: 'number' },
    ruleId: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/**
 * Referral list response schema
 */
export const referralListResponseSchema = {
  type: 'object',
  properties: {
    data: { type: 'array', items: referralResponseSchema },
    total: { type: 'number' },
    page: { type: 'number' },
    limit: { type: 'number' },
    totalPages: { type: 'number' },
  },
} as const;

/**
 * Referral stats response schema
 */
export const referralStatsResponseSchema = {
  type: 'object',
  properties: {
    totalReferrals: { type: 'number' },
    activeReferrals: { type: 'number' },
    completedReferrals: { type: 'number' },
    totalRewardsPaid: { type: 'number' },
    pendingRewards: { type: 'number' },
    topReferrers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          referralCount: { type: 'number' },
          totalRewards: { type: 'number' },
        },
      },
    },
  },
} as const;

/**
 * Rule response schema
 */
export const ruleResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    type: { type: 'string' },
    referrerReward: { type: 'number' },
    referredReward: { type: 'number' },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/**
 * Zod schemas for validation
 */
export const createReferralBodySchema = z.object({
  referrerId: z.string().uuid(),
  referredId: z.string().uuid(),
  referralCode: z.string().optional(),
  ruleId: z.string().uuid().optional(),
  referrerReward: z.number().min(0).optional(),
  referredReward: z.number().min(0).optional(),
  notes: z.string().optional(),
});

export const updateReferralBodySchema = z.object({
  status: z.enum(['active', 'completed', 'cancelled']).optional(),
  cancelledReason: z.string().optional(),
  notes: z.string().optional(),
});

export const referralIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const referralFiltersQuerySchema = z.object({
  status: z.enum(['active', 'completed', 'cancelled']).optional(),
  referrerId: z.string().uuid().optional(),
  referredId: z.string().uuid().optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  sortBy: z.string().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const createRuleBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['first_purchase', 'cumulative', 'subscription']),
  referrerReward: z.number().min(0),
  referredReward: z.number().min(0),
  minPurchaseAmount: z.number().min(0).optional(),
  isActive: z.boolean().optional().default(true),
});

export const updateRuleBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  type: z.enum(['first_purchase', 'cumulative', 'subscription']).optional(),
  referrerReward: z.number().min(0).optional(),
  referredReward: z.number().min(0).optional(),
  minPurchaseAmount: z.number().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const ruleIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export type CreateReferralBody = z.infer<typeof createReferralBodySchema>;
export type UpdateReferralBody = z.infer<typeof updateReferralBodySchema>;
export type ReferralIdParams = z.infer<typeof referralIdParamsSchema>;
export type ReferralFiltersQuery = z.infer<typeof referralFiltersQuerySchema>;
export type CreateRuleBody = z.infer<typeof createRuleBodySchema>;
export type UpdateRuleBody = z.infer<typeof updateRuleBodySchema>;
export type RuleIdParams = z.infer<typeof ruleIdParamsSchema>;
