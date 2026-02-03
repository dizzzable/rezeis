import axios, { AxiosError } from 'axios';
import type { AxiosInstance, AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios';
import type { ApiError } from '../types/auth.types';

/**
 * API base URL from environment variables
 */
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/**
 * Local storage key for JWT token
 */
const TOKEN_KEY = 'auth_token';

/**
 * Local storage key for refresh token
 */
const REFRESH_TOKEN_KEY = 'refresh_token';

/**
 * Flag to prevent multiple simultaneous refresh attempts
 */
let isRefreshing = false;

/**
 * Queue of requests waiting for token refresh
 */
let refreshSubscribers: Array<(token: string) => void> = [];

/**
 * Subscribe to token refresh
 * @param callback Function to call when token is refreshed
 */
function subscribeTokenRefresh(callback: (token: string) => void): void {
  refreshSubscribers.push(callback);
}

/**
 * Notify all subscribers about new token
 * @param token New access token
 */
function onTokenRefreshed(token: string): void {
  refreshSubscribers.forEach((callback) => callback(token));
  refreshSubscribers = [];
}

/**
 * Get stored access token
 * @returns JWT token or null
 */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Get stored refresh token
 * @returns Refresh token or null
 */
export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

/**
 * Store access token
 * @param token JWT token
 */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Store refresh token
 * @param token Refresh token
 */
export function setRefreshToken(token: string): void {
  localStorage.setItem(REFRESH_TOKEN_KEY, token);
}

/**
 * Remove all stored tokens
 */
export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

/**
 * Create axios instance with default configuration
 */
const apiClient: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

/**
 * Request interceptor - add Authorization header
 */
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getToken();
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error: AxiosError) => {
    return Promise.reject(error);
  }
);

/**
 * Response interceptor - handle 401 and token refresh
 */
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiError>) => {
    const originalRequest = error.config as AxiosRequestConfig & { _retry?: boolean };

    if (!originalRequest) {
      return Promise.reject(error);
    }

    // Handle 401 Unauthorized
    if (error.response?.status === 401 && !originalRequest._retry) {
      const refreshToken = getRefreshToken();

      // No refresh token available - logout and redirect
      if (!refreshToken) {
        clearTokens();
        window.location.href = '/login';
        return Promise.reject(error);
      }

      // Already refreshing - queue this request
      if (isRefreshing) {
        return new Promise((resolve) => {
          subscribeTokenRefresh((token: string) => {
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${token}`;
            }
            resolve(apiClient(originalRequest));
          });
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        // Attempt to refresh token
        const response = await axios.post<{
          token: string;
          refreshToken?: string;
        }>(`${API_BASE_URL}/auth/refresh`, {
          refreshToken,
        });

        const { token, refreshToken: newRefreshToken } = response.data;

        // Store new tokens
        setToken(token);
        if (newRefreshToken) {
          setRefreshToken(newRefreshToken);
        }

        // Notify subscribers
        onTokenRefreshed(token);
        isRefreshing = false;

        // Retry original request with new token
        if (originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${token}`;
        }
        return apiClient(originalRequest);
      } catch (refreshError) {
        // Refresh failed - clear tokens and redirect to login
        clearTokens();
        isRefreshing = false;
        refreshSubscribers = [];
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    // Handle other errors
    return Promise.reject(error);
  }
);

/**
 * Handle API errors and return user-friendly messages
 * @param error Axios error object
 * @returns Formatted error message
 */
export function getErrorMessage(error: AxiosError<ApiError>): string {
  if (error.response?.data?.error) {
    return error.response.data.error;
  }

  if (error.response?.status === 401) {
    return 'Session expired. Please log in again.';
  }

  if (error.response?.status === 403) {
    return 'You do not have permission to perform this action.';
  }

  if (error.response?.status === 404) {
    return 'The requested resource was not found.';
  }

  if (error.response?.status === 409) {
    return 'This resource already exists.';
  }

  if (error.response?.status === 422) {
    return 'Invalid data provided. Please check your input.';
  }

  if (error.response?.status === 500) {
    return 'An internal server error occurred. Please try again later.';
  }

  if (error.request) {
    return 'Network error. Please check your connection.';
  }

  return error.message || 'An unexpected error occurred.';
}

/**
 * Type guard for API errors
 * @param error Unknown error object
 * @returns True if error is an Axios error
 */
export function isAxiosError(error: unknown): error is AxiosError<ApiError> {
  return axios.isAxiosError(error);
}

export default apiClient;
