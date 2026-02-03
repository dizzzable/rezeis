/**
 * Zustand stores for state management
 *
 * This module contains all global state stores used throughout
 * the application.
 *
 * @example
 * ```typescript
 * import { useAuthStore, useAuth, useAuthActions } from './stores';
 *
 * // Use auth store directly
 * const user = useAuthStore((state) => state.user);
 *
 * // Use convenience hooks
 * const { user, isAuthenticated } = useAuth();
 * const { loginWithEmail, logout } = useAuthActions();
 * ```
 */

export {
  useAuthStore,
  useAuth,
  useAuthActions,
  useHasRole,
  useIsAdmin,
} from './auth.store';

export type { AuthState } from './auth.store';
