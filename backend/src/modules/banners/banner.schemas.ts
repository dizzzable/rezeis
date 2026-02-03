import { z } from 'zod';

/**
 * Banner position enum schema
 */
export const bannerPositionSchema = z.enum(['home_top', 'home_bottom', 'plans_page', 'sidebar']);

/**
 * Banner schema
 */
export const bannerSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  imageUrl: z.string(),
  linkUrl: z.string().optional(),
  position: bannerPositionSchema,
  displayOrder: z.number(),
  isActive: z.boolean(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  clickCount: z.number(),
  impressionCount: z.number(),
  backgroundColor: z.string().optional(),
  textColor: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Create banner schema
 */
export const createBannerSchema = z.object({
  title: z.string().min(1).max(255),
  subtitle: z.string().max(500).optional(),
  imageUrl: z.string().url().max(1000),
  linkUrl: z.string().url().max(1000).optional(),
  position: bannerPositionSchema,
  displayOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

/**
 * Update banner schema
 */
export const updateBannerSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  subtitle: z.string().max(500).optional(),
  imageUrl: z.string().url().max(1000).optional(),
  linkUrl: z.string().url().max(1000).optional(),
  position: bannerPositionSchema.optional(),
  displayOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

/**
 * Get banners query schema
 */
export const getBannersQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  position: bannerPositionSchema.optional(),
  isActive: z.coerce.boolean().optional(),
});

/**
 * Get active banners by position query schema
 */
export const getActiveBannersByPositionQuerySchema = z.object({
  position: bannerPositionSchema,
});

/**
 * Banner params schema (for routes with ID)
 */
export const bannerParamsSchema = z.object({
  id: z.string(),
});

/**
 * Track banner click body schema
 */
export const trackBannerClickBodySchema = z.object({
  bannerId: z.string(),
});

/**
 * Track banner impression body schema
 */
export const trackBannerImpressionBodySchema = z.object({
  bannerId: z.string(),
});

/**
 * Banner statistics schema
 */
export const bannerStatisticsSchema = z.object({
  bannerId: z.string(),
  clickCount: z.number(),
  impressionCount: z.number(),
  ctr: z.number(),
});

/**
 * Paginated banners response schema
 */
export const paginatedBannersResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    data: z.array(bannerSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
  }),
  message: z.string().optional(),
});

/**
 * Banner response wrapper schema
 */
export const bannerResponseSchema = z.object({
  success: z.boolean(),
  data: bannerSchema,
  message: z.string().optional(),
});

/**
 * Banners list response schema (for active banners)
 */
export const bannersListResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(bannerSchema),
  message: z.string().optional(),
});

/**
 * Delete banner response schema
 */
export const deleteBannerResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

/**
 * Track banner stats response schema
 */
export const trackBannerStatsResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    bannerId: z.string(),
    clickCount: z.number(),
    impressionCount: z.number(),
  }),
  message: z.string().optional(),
});

/**
 * Banner statistics response schema
 */
export const bannerStatisticsResponseSchema = z.object({
  success: z.boolean(),
  data: bannerStatisticsSchema,
  message: z.string().optional(),
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
export type BannerResponse = z.infer<typeof bannerSchema>;
export type BannerPosition = z.infer<typeof bannerPositionSchema>;
export type CreateBannerInput = z.infer<typeof createBannerSchema>;
export type UpdateBannerInput = z.infer<typeof updateBannerSchema>;
export type GetBannersQuery = z.infer<typeof getBannersQuerySchema>;
export type GetActiveBannersByPositionQuery = z.infer<typeof getActiveBannersByPositionQuerySchema>;
export type BannerParams = z.infer<typeof bannerParamsSchema>;
export type TrackBannerClickInput = z.infer<typeof trackBannerClickBodySchema>;
export type TrackBannerImpressionInput = z.infer<typeof trackBannerImpressionBodySchema>;
export type BannerStatisticsResponse = z.infer<typeof bannerStatisticsSchema>;
