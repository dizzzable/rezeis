import apiClient, { clearTokens, setToken, getErrorMessage, isAxiosError } from './client';
import type {
  AuthResponse,
  LoginCredentials,
  RegisterData,
  User,
  LogoutResponse,
  GetMeResponse,
  SetupStatusResponse,
  SetupSuperAdminData,
} from '../types/auth.types';
import type { AxiosError } from 'axios';
import type { ApiError } from '../types/auth.types';

/**
 * Parameters for Telegram authentication
 */
interface TelegramAuthParams {
  /** Telegram WebApp initData string */
  initData: string;
}

/**
 * Parameters for username login
 */
interface UsernameLoginParams {
  /** Login credentials (username and password) */
  credentials: LoginCredentials;
}

/**
 * Parameters for user registration
 */
interface RegisterParams {
  /** Registration data */
  data: RegisterData;
}

/**
 * Authenticate user via Telegram WebApp
 * @param params Object containing initData from Telegram WebApp
 * @returns Promise with authentication response containing token and user data
 * @throws Error if authentication fails
 */
export async function telegramAuth(params: TelegramAuthParams): Promise<AuthResponse> {
  try {
    const { data } = await apiClient.post<AuthResponse>('/auth/telegram', {
      initData: params.initData,
    });

    // Store tokens on successful authentication
    if (data.token) {
      setToken(data.token);
    }

    return data;
  } catch (error) {
    if (isAxiosError(error)) {
      throw new Error(getErrorMessage(error as AxiosError<ApiError>));
    }
    throw new Error('Failed to authenticate with Telegram');
  }
}

/**
 * Login user with username and password
 * @param params Object containing login credentials
 * @returns Promise with authentication response containing token and user data
 * @throws Error if login fails
 */
export async function usernameLogin(params: UsernameLoginParams): Promise<AuthResponse> {
  try {
    const { data } = await apiClient.post<AuthResponse>('/auth/login', params.credentials);

    // Store tokens on successful login
    if (data.token) {
      setToken(data.token);
    }

    return data;
  } catch (error) {
    if (isAxiosError(error)) {
      throw new Error(getErrorMessage(error as AxiosError<ApiError>));
    }
    throw new Error('Failed to login with username');
  }
}

/**
 * Register new user
 * @param params Object containing registration data
 * @returns Promise with authentication response containing token and user data
 * @throws Error if registration fails
 */
export async function register(params: RegisterParams): Promise<AuthResponse> {
  try {
    const { data } = await apiClient.post<AuthResponse>('/auth/register', params.data);

    // Store tokens on successful registration
    if (data.token) {
      setToken(data.token);
    }

    return data;
  } catch (error) {
    if (isAxiosError(error)) {
      throw new Error(getErrorMessage(error as AxiosError<ApiError>));
    }
    throw new Error('Failed to register user');
  }
}

/**
 * Logout current user
 * @returns Promise that resolves when logout is complete
 * @throws Error if logout fails
 */
export async function logout(): Promise<void> {
  try {
    await apiClient.post<LogoutResponse>('/auth/logout');
  } catch (error) {
    // Even if server logout fails, clear local tokens
    clearTokens();

    if (isAxiosError(error)) {
      throw new Error(getErrorMessage(error as AxiosError<ApiError>));
    }
    throw new Error('Failed to logout');
  } finally {
    clearTokens();
  }
}

/**
 * Get current authenticated user
 * @returns Promise with current user data
 * @throws Error if fetching user fails
 */
export async function getMe(): Promise<User> {
  try {
    const { data } = await apiClient.get<GetMeResponse>('/auth/me');
    return data.user;
  } catch (error) {
    if (isAxiosError(error)) {
      throw new Error(getErrorMessage(error as AxiosError<ApiError>));
    }
    throw new Error('Failed to fetch user data');
  }
}

/**
 * Refresh access token using refresh token
 * @returns Promise with new authentication response containing refreshed token
 * @throws Error if token refresh fails
 */
export async function refreshToken(): Promise<AuthResponse> {
  try {
    const refreshTokenValue = localStorage.getItem('refresh_token');

    if (!refreshTokenValue) {
      throw new Error('No refresh token available');
    }

    const { data } = await apiClient.post<AuthResponse>('/auth/refresh', {
      refreshToken: refreshTokenValue,
    });

    // Store new tokens
    if (data.token) {
      setToken(data.token);
    }

    return data;
  } catch (error) {
    if (isAxiosError(error)) {
      throw new Error(getErrorMessage(error as AxiosError<ApiError>));
    }
    throw new Error('Failed to refresh token');
  }
}

/**
 * Check if user is authenticated (has token)
 * @returns True if token exists in localStorage
 */
export function isAuthenticated(): boolean {
  return !!localStorage.getItem('auth_token');
}

/**
 * Check if initial setup is required
 * @returns Promise with setup status
 * @throws Error if check fails
 */
export async function checkSetupStatus(): Promise<boolean> {
  try {
    const { data } = await apiClient.get<SetupStatusResponse>('/auth/setup-status');
    return data.needsSetup;
  } catch (error) {
    if (isAxiosError(error)) {
      throw new Error(getErrorMessage(error as AxiosError<ApiError>));
    }
    throw new Error('Failed to check setup status');
  }
}

/**
 * Setup super admin for initial configuration
 * @param data Super admin setup data
 * @throws Error if setup fails
 */
export async function setupSuperAdmin(data: SetupSuperAdminData): Promise<void> {
  try {
    await apiClient.post('/auth/setup', data);
  } catch (error) {
    if (isAxiosError(error)) {
      throw new Error(getErrorMessage(error as AxiosError<ApiError>));
    }
    throw new Error('Failed to create super admin');
  }
}

/**
 * Auth service object with all authentication methods
 */
export const authService = {
  telegramAuth,
  usernameLogin,
  register,
  logout,
  getMe,
  refreshToken,
  isAuthenticated,
  checkSetupStatus,
  setupSuperAdmin,
};

export default authService;
