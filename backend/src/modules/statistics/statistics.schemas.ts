import { z } from 'zod';

/**
 * Daily statistics schema
 */
export const dailyStatisticsSchema = z.object({
  id: z.string(),
  date: z.string(),
  newUsers: z.number(),
  activeUsers: z.number(),
  newSubscriptions: z.number(),
  revenue: z.number(),
  createdAt: z.string(),
});

/**
 * Dashboard stats schema
 */
export const dashboardStatsSchema = z.object({
  totalRevenue: z.number(),
  newUsersToday: z.number(),
  newSubscriptionsToday: z.number(),
  activeUsersToday: z.number(),
});

/**
 * Revenue stats schema
 */
export const revenueStatsSchema = z.object({
  totalRevenue: z.number(),
  periodRevenue: z.number(),
  averageDailyRevenue: z.number(),
  growthRate: z.number(),
});

/**
 * User stats schema
 */
export const userStatsSchema = z.object({
  totalUsers: z.number(),
  activeUsers: z.number(),
  blockedUsers: z.number(),
  newUsersThisMonth: z.number(),
  growthRate: z.number(),
});

/**
 * Subscription stats schema
 */
export const subscriptionStatsSchema = z.object({
  totalSubscriptions: z.number(),
  activeSubscriptions: z.number(),
  expiredSubscriptions: z.number(),
  cancelledSubscriptions: z.number(),
  expiringSoon: z.number(),
});

/**
 * Date range query schema
 */
export const dateRangeQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

/**
 * Dashboard response schema
 */
export const dashboardResponseSchema = z.object({
  success: z.boolean(),
  data: dashboardStatsSchema,
  message: z.string().optional(),
});

/**
 * Revenue stats response schema
 */
export const revenueStatsResponseSchema = z.object({
  success: z.boolean(),
  data: revenueStatsSchema,
  message: z.string().optional(),
});

/**
 * User stats response schema
 */
export const userStatsResponseSchema = z.object({
  success: z.boolean(),
  data: userStatsSchema,
  message: z.string().optional(),
});

/**
 * Subscription stats response schema
 */
export const subscriptionStatsResponseSchema = z.object({
  success: z.boolean(),
  data: subscriptionStatsSchema,
  message: z.string().optional(),
});

/**
 * Daily statistics list response schema
 */
export const dailyStatisticsListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(dailyStatisticsSchema),
  message: z.string().optional(),
});

/**
 * Type definitions
 */
export type DailyStatisticsResponse = z.infer<typeof dailyStatisticsSchema>;
export type DashboardStats = z.infer<typeof dashboardStatsSchema>;
export type RevenueStats = z.infer<typeof revenueStatsSchema>;
export type UserStats = z.infer<typeof userStatsSchema>;
export type SubscriptionStats = z.infer<typeof subscriptionStatsSchema>;
export type DateRangeQuery = z.infer<typeof dateRangeQuerySchema>;
