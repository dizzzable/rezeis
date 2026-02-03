import { z } from 'zod';

/**
 * Admin role enum
 */
export const adminRoleSchema = z.enum(['super_admin', 'admin']);

/**
 * Admin response schema
 */
export const adminSchema = z.object({
  id: z.string(),
  telegramId: z.string(),
  username: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  role: adminRoleSchema,
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Create admin schema
 */
export const createAdminSchema = z.object({
  telegramId: z.string().min(1, 'Telegram ID is required'),
  username: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  role: adminRoleSchema.default('admin'),
  isActive: z.boolean().default(true),
});

/**
 * Update admin role schema
 */
export const updateAdminRoleSchema = z.object({
  role: adminRoleSchema,
});

/**
 * Get admins query params schema
 */
export const getAdminsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  role: adminRoleSchema.optional(),
  isActive: z.coerce.boolean().optional(),
  search: z.string().optional(),
});

/**
 * Admin params schema (for routes with ID)
 */
export const adminParamsSchema = z.object({
  id: z.string(),
});

/**
 * Paginated admins response schema
 */
export const paginatedAdminsResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    data: z.array(adminSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
    totalPages: z.number(),
  }),
  message: z.string().optional(),
});

/**
 * Admin response wrapper schema
 */
export const adminResponseSchema = z.object({
  success: z.boolean(),
  data: adminSchema,
  message: z.string().optional(),
});

/**
 * Delete admin response schema
 */
export const deleteAdminResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
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
export type AdminResponse = z.infer<typeof adminSchema>;
export type CreateAdminInput = z.infer<typeof createAdminSchema>;
export type UpdateAdminRoleInput = z.infer<typeof updateAdminRoleSchema>;
export type GetAdminsQuery = z.infer<typeof getAdminsQuerySchema>;
export type AdminParams = z.infer<typeof adminParamsSchema>;
