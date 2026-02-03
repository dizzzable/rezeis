import { z } from 'zod';

/**
 * User role enum
 */
export const userRoleSchema = z.enum(['admin', 'user']);

/**
 * User response schema
 */
export const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  telegramId: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  photoUrl: z.string().optional(),
  role: userRoleSchema,
  isActive: z.boolean(),
  lastLoginAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Create user schema
 */
export const createUserSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters').optional(),
  telegramId: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  photoUrl: z.string().optional(),
  role: userRoleSchema.default('user'),
  isActive: z.boolean().default(true),
});

/**
 * Update user schema
 */
export const updateUserSchema = z.object({
  username: z.string().min(3).optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  photoUrl: z.string().optional(),
  role: userRoleSchema.optional(),
  isActive: z.boolean().optional(),
});

/**
 * Get users query params schema
 */
export const getUsersQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  role: userRoleSchema.optional(),
  isActive: z.coerce.boolean().optional(),
  search: z.string().optional(),
});

/**
 * Block user params schema
 */
export const blockUserParamsSchema = z.object({
  id: z.string(),
});

/**
 * Unblock user params schema
 */
export const unblockUserParamsSchema = z.object({
  id: z.string(),
});

/**
 * Get user subscriptions params schema
 */
export const getUserSubscriptionsParamsSchema = z.object({
  id: z.string(),
});

/**
 * Get user details params schema
 */
export const getUserDetailsParamsSchema = z.object({
  id: z.string(),
});

/**
 * User subscription with plan info schema
 */
export const userSubscriptionWithPlanSchema = z.object({
  id: z.string(),
  userId: z.string(),
  planId: z.string(),
  planName: z.string(),
  planPrice: z.number(),
  status: z.enum(['active', 'expired', 'cancelled', 'pending']),
  startDate: z.string(),
  endDate: z.string(),
  remnawaveUuid: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * User partner info schema
 */
export const userPartnerInfoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  commissionRate: z.number(),
  totalEarnings: z.number(),
  paidEarnings: z.number(),
  pendingEarnings: z.number(),
  referralCode: z.string(),
  referralCount: z.number(),
  status: z.enum(['pending', 'active', 'suspended', 'rejected']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * User referral info schema
 */
export const userReferralInfoSchema = z.object({
  id: z.string(),
  referrerId: z.string(),
  referredId: z.string(),
  referralCode: z.string().optional(),
  status: z.enum(['active', 'completed', 'cancelled']),
  referrerReward: z.number(),
  referredReward: z.number(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
});

/**
 * User referral reward schema
 */
export const userReferralRewardSchema = z.object({
  id: z.string(),
  referralId: z.string(),
  userId: z.string(),
  amount: z.number(),
  status: z.enum(['pending', 'approved', 'paid', 'cancelled']),
  createdAt: z.string(),
  paidAt: z.string().optional(),
});

/**
 * User activity log schema
 */
export const userActivitySchema = z.object({
  id: z.string(),
  userId: z.string(),
  action: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
});

/**
 * User stats schema
 */
export const userStatsSchema = z.object({
  totalSubscriptions: z.number(),
  activeSubscriptions: z.number(),
  totalSpent: z.number(),
  partnerEarnings: z.number(),
  referralsCount: z.number(),
  rewardsEarned: z.number(),
});

/**
 * User details response schema
 */
export const userDetailsResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    user: userSchema,
    subscriptions: z.array(userSubscriptionWithPlanSchema),
    partner: userPartnerInfoSchema.nullable(),
    partnerEarnings: z.array(z.object({
      id: z.string(),
      partnerId: z.string(),
      amount: z.number(),
      status: z.string(),
      createdAt: z.string(),
    })),
    referralsSent: z.array(userReferralInfoSchema),
    referralsReceived: userReferralInfoSchema.nullable(),
    referralRewards: z.array(userReferralRewardSchema),
    activity: z.array(userActivitySchema),
    stats: userStatsSchema,
  }),
  message: z.string().optional(),
});

/**
 * Paginated users response schema
 */
export const paginatedUsersResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    data: z.array(userSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
  }),
  message: z.string().optional(),
});

/**
 * User response wrapper schema
 */
export const userResponseSchema = z.object({
  success: z.boolean(),
  data: userSchema,
  message: z.string().optional(),
});

/**
 * User subscriptions response schema
 */
export const userSubscriptionsResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(z.object({
    id: z.string(),
    userId: z.string(),
    planId: z.string(),
    status: z.enum(['active', 'expired', 'cancelled', 'pending']),
    startDate: z.string(),
    endDate: z.string(),
    remnawaveUuid: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
  message: z.string().optional(),
});

/**
 * Type definitions
 */
export type UserResponse = z.infer<typeof userSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type GetUsersQuery = z.infer<typeof getUsersQuerySchema>;
export type BlockUserParams = z.infer<typeof blockUserParamsSchema>;
export type UnblockUserParams = z.infer<typeof unblockUserParamsSchema>;
export type GetUserSubscriptionsParams = z.infer<typeof getUserSubscriptionsParamsSchema>;
export type GetUserDetailsParams = z.infer<typeof getUserDetailsParamsSchema>;
export type UserDetailsResponse = z.infer<typeof userDetailsResponseSchema>;
export type UserSubscriptionWithPlan = z.infer<typeof userSubscriptionWithPlanSchema>;
export type UserPartnerInfo = z.infer<typeof userPartnerInfoSchema>;
export type UserReferralInfo = z.infer<typeof userReferralInfoSchema>;
export type UserReferralReward = z.infer<typeof userReferralRewardSchema>;
export type UserActivity = z.infer<typeof userActivitySchema>;
export type UserStats = z.infer<typeof userStatsSchema>;
