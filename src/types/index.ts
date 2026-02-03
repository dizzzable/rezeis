/**
 * Type definitions for the rezeis-panel application
 *
 * This module contains all TypeScript interfaces and type definitions
 * used throughout the application.
 */

// Auth types
export type {
  UserRole,
  User,
  AuthResponse,
  LoginCredentials,
  RegisterData,
  TelegramUser,
  LogoutResponse,
  GetMeResponse,
  ApiError,
} from './auth.types';

// Entity types
export type {
  User as EntityUser,
  CreateUserDTO,
  UpdateUserDTO,
  GetUsersParams,
  SubscriptionStatus,
  Subscription,
  CreateSubscriptionDTO,
  UpdateSubscriptionDTO,
  GetSubscriptionsParams,
  Plan,
  CreatePlanDTO,
  UpdatePlanDTO,
  PaginatedResult,
  DashboardStats,
  RevenueStats,
  UserStats,
  SubscriptionStats,
  DailyStatistics,
  ApiResponse as EntityApiResponse,
  Admin,
  AdminRole,
  CreateAdminDTO,
  UpdateAdminDTO,
  GetAdminsParams,
} from './entity.types';

// Telegram WebApp types are global declarations
// No exports needed as they extend the Window interface
