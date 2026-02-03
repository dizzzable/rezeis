import { z } from 'zod';

/**
 * Login request schema
 */
export const loginSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

/**
 * Login request type
 */
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Register request schema
 */
export const registerSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  name: z.string().min(2, 'Name must be at least 2 characters'),
});

/**
 * Register request type
 */
export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * User response schema (for API responses)
 */
export const userResponseSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  role: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * User response type
 */
export type UserResponse = z.infer<typeof userResponseSchema>;

/**
 * Login response schema
 */
export const loginResponseSchema = z.object({
  token: z.string(),
  user: userResponseSchema,
});

/**
 * Login response type
 */
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * Refresh token request schema
 */
export const refreshTokenSchema = z.object({
  refreshToken: z.string(),
});

/**
 * Refresh token request type
 */
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

/**
 * Telegram WebApp authentication request schema
 */
export const telegramAuthSchema = z.object({
  initData: z.string().min(1, 'initData is required'),
});

/**
 * Telegram WebApp authentication request type
 */
export type TelegramAuthInput = z.infer<typeof telegramAuthSchema>;

/**
 * Telegram user data from initData
 */
export interface TelegramUserData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  language_code?: string;
}

/**
 * Telegram authentication result
 */
export interface TelegramAuthResult {
  token: string;
  user: UserResponse;
}

/**
 * Setup super admin request schema
 */
export const setupSuperAdminSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  telegramId: z.string().regex(/^\d+$/, 'Telegram ID must contain only digits'),
});

/**
 * Setup super admin request type
 */
export type SetupSuperAdminInput = z.infer<typeof setupSuperAdminSchema>;

/**
 * Setup status response
 */
export interface SetupStatusResponse {
  needsSetup: boolean;
}
