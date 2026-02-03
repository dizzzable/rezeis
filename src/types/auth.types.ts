/**
 * User role type
 */
export type UserRole = 'super_admin' | 'admin' | 'user';

/**
 * User interface representing authenticated user data
 */
export interface User {
  /** Unique user identifier */
  id: string;
  /** User's telegram ID if authenticated via Telegram */
  telegramId?: string;
  /** User's username for login */
  username: string;
  /** User's display name */
  name?: string;
  /** User's first name (for Telegram users) */
  firstName?: string;
  /** User's last name (for Telegram users) */
  lastName?: string;
  /** URL to user's profile photo */
  photoUrl?: string;
  /** User role for authorization */
  role: UserRole;
  /** User's preferred language */
  language?: string;
  /** Account creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Authentication response from API
 */
export interface AuthResponse {
  /** Indicates if the authentication was successful */
  success: boolean;
  /** JWT access token */
  token: string;
  /** Authenticated user data */
  user: User;
}

/**
 * Username login credentials
 */
export interface LoginCredentials {
  /** User's username */
  username: string;
  /** User's password */
  password: string;
}

/**
 * Registration data for new users
 */
export interface RegisterData {
  /** User's username (minimum 3 characters) */
  username: string;
  /** User's password (minimum 6 characters) */
  password: string;
  /** User's display name (minimum 2 characters) */
  name: string;
}

/**
 * Telegram WebApp user data
 */
export interface TelegramUser {
  /** Telegram user ID */
  id: number;
  /** User's first name */
  first_name: string;
  /** User's last name (optional) */
  last_name?: string;
  /** Telegram username (optional) */
  username?: string;
  /** URL to user's profile photo (optional) */
  photo_url?: string;
  /** User's language code (optional) */
  language_code?: string;
}

/**
 * Logout response from API
 */
export interface LogoutResponse {
  /** Success message */
  message: string;
}

/**
 * Get current user response from API
 */
export interface GetMeResponse {
  /** Current user data */
  user: User;
}

/**
 * API error response structure
 */
export interface ApiError {
  /** Error message */
  error: string;
  /** HTTP status code */
  statusCode?: number;
}

/**
 * Setup status response from API
 */
export interface SetupStatusResponse {
  /** Whether initial setup is required */
  needsSetup: boolean;
}

/**
 * Setup super admin request data
 */
export interface SetupSuperAdminData {
  /** Admin username (minimum 3 characters) */
  username: string;
  /** Admin password (minimum 8 characters) */
  password: string;
  /** Telegram ID from .env SUPER_ADMIN_TELEGRAM_ID */
  telegramId: string;
}
