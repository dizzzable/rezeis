import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { telegramAuth, usernameLogin, logout, getMe } from '../api/auth.service';
import { setToken, clearTokens } from '../api/client';
import { isInTelegram, getInitData } from '../services/telegram';
import { updateUserLanguage } from '../api/client.service';
import type { User, LoginCredentials, RegisterData } from '../types/auth.types';

/**
 * Parameters for login with Telegram
 */
interface LoginWithTelegramParams {
  /** Telegram WebApp initData string */
  initData: string;
}

/**
 * Parameters for login with email
 */
interface LoginWithEmailParams {
  /** Email login credentials */
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
 * Authentication state interface
 */
export interface AuthState {
  /** Current authenticated user or null if not authenticated */
  user: User | null;
  /** Whether user is currently authenticated */
  isAuthenticated: boolean;
  /** Whether an async auth operation is in progress */
  isLoading: boolean;
  /** Current error message or null if no error */
  error: string | null;
  /** JWT token stored for persistence */
  token: string | null;

  /**
   * Authenticate user via Telegram WebApp
   * @param params Object containing initData from Telegram
   */
  loginWithTelegram: (params: LoginWithTelegramParams) => Promise<void>;

  /**
   * Login user with email and password
   * @param params Object containing login credentials
   */
  loginWithEmail: (params: LoginWithEmailParams) => Promise<void>;

  /**
   * Register new user
   * @param params Object containing registration data
   */
  register: (params: RegisterParams) => Promise<void>;

  /**
   * Logout current user and clear state
   */
  logout: () => Promise<void>;

  /**
   * Fetch current user data from API
   */
  fetchUser: () => Promise<void>;

  /**
   * Clear current error message
   */
  clearError: () => void;

  /**
   * Set user data directly (used after registration/login)
   * @param user User object to set
   */
  setUser: (user: User) => void;

  /**
   * Initialize auth state - check if user is authenticated on app load
   */
  initialize: () => Promise<void>;

  /**
   * Try to login with Telegram initData if available
   * @returns True if login was attempted, false otherwise
   */
  tryLoginWithTelegramInitData: () => Promise<boolean>;

  /**
   * Update user language preference
   * @param language - Language code ('ru' | 'en')
   */
  updateLanguage: (language: string) => Promise<void>;
}

/**
 * Zustand store for authentication state management
 * Uses persist middleware to save user and token to localStorage
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      token: null,

      loginWithTelegram: async (params: LoginWithTelegramParams) => {
        set({ isLoading: true, error: null });

        try {
          const response = await telegramAuth({ initData: params.initData });

          if (response.token) {
            setToken(response.token);
          }

          set({
            user: response.user,
            isAuthenticated: true,
            token: response.token,
            isLoading: false,
            error: null,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to login with Telegram';
          set({
            user: null,
            isAuthenticated: false,
            token: null,
            isLoading: false,
            error: errorMessage,
          });
          throw error;
        }
      },

      loginWithEmail: async (params: LoginWithEmailParams) => {
        set({ isLoading: true, error: null });

        try {
          const response = await usernameLogin({ credentials: params.credentials });

          if (response.token) {
            setToken(response.token);
          }

          set({
            user: response.user,
            isAuthenticated: true,
            token: response.token,
            isLoading: false,
            error: null,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to login with username';
          set({
            user: null,
            isAuthenticated: false,
            token: null,
            isLoading: false,
            error: errorMessage,
          });
          throw error;
        }
      },

      register: async (params: RegisterParams) => {
        set({ isLoading: true, error: null });

        try {
          const { register } = await import('../api/auth.service');
          const response = await register({ data: params.data });

          if (response.token) {
            setToken(response.token);
          }

          set({
            user: response.user,
            isAuthenticated: true,
            token: response.token,
            isLoading: false,
            error: null,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to register';
          set({
            user: null,
            isAuthenticated: false,
            token: null,
            isLoading: false,
            error: errorMessage,
          });
          throw error;
        }
      },

      logout: async () => {
        set({ isLoading: true });

        try {
          await logout();
        } catch {
          // Even if server logout fails, clear local state
        } finally {
          clearTokens();
          set({
            user: null,
            isAuthenticated: false,
            token: null,
            isLoading: false,
            error: null,
          });
        }
      },

      fetchUser: async () => {
        const { isAuthenticated: isAuth } = get();

        if (!isAuth) {
          return;
        }

        set({ isLoading: true, error: null });

        try {
          const user = await getMe();
          set({
            user,
            isLoading: false,
            error: null,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to fetch user';

          // If fetching user fails, user is probably not authenticated anymore
          if (errorMessage.includes('401') || errorMessage.includes('unauthorized')) {
            clearTokens();
            set({
              user: null,
              isAuthenticated: false,
              token: null,
              isLoading: false,
              error: errorMessage,
            });
          } else {
            set({
              isLoading: false,
              error: errorMessage,
            });
          }
        }
      },

      clearError: () => {
        set({ error: null });
      },

      setUser: (user: User) => {
        set({
          user,
          isAuthenticated: true,
        });
      },

      initialize: async () => {
        const { token } = get();

        // First, try to login with Telegram initData if in Mini App
        if (isInTelegram()) {
          const telegramLoginAttempted = await get().tryLoginWithTelegramInitData();
          if (telegramLoginAttempted) {
            return;
          }
        }

        if (token) {
          // Restore token to axios client
          setToken(token);
          // Fetch user data to validate token
          await get().fetchUser();
        }
      },

      tryLoginWithTelegramInitData: async () => {
        // Only proceed if we have valid initData
        if (!isInTelegram()) {
          return false;
        }

        const initData = getInitData();
        if (!initData) {
          return false;
        }

        try {
          await get().loginWithTelegram({ initData });
          return true;
        } catch {
          // Telegram login failed, will fallback to regular auth
          return false;
        }
      },

      updateLanguage: async (language: string) => {
        try {
          await updateUserLanguage(language);
          set((state) => ({
            user: state.user ? { ...state.user, language } : null,
          }));
        } catch (error) {
          console.error('Failed to update language:', error);
          throw error;
        }
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);

/**
 * Hook to get authentication state
 * @returns Pick of AuthState with user, isAuthenticated, isLoading, error
 */
export function useAuth() {
  return useAuthStore((state) => ({
    user: state.user,
    isAuthenticated: state.isAuthenticated,
    isLoading: state.isLoading,
    error: state.error,
    updateLanguage: state.updateLanguage,
  }));
}

/**
 * Hook to get authentication actions
 * @returns Object with all auth actions
 */
export function useAuthActions() {
  return useAuthStore((state) => ({
    loginWithTelegram: state.loginWithTelegram,
    loginWithEmail: state.loginWithEmail,
    register: state.register,
    logout: state.logout,
    fetchUser: state.fetchUser,
    clearError: state.clearError,
    initialize: state.initialize,
    tryLoginWithTelegramInitData: state.tryLoginWithTelegramInitData,
  }));
}

/**
 * Hook to check if user has specific role
 * @param role Role to check
 * @returns True if user has the specified role
 */
export function useHasRole(role: 'admin' | 'user'): boolean {
  return useAuthStore((state) => state.user?.role === role);
}

/**
 * Hook to check if user is admin
 * @returns True if user is admin
 */
export function useIsAdmin(): boolean {
  return useHasRole('admin');
}

export default useAuthStore;
