/**
 * usePermissionStore
 * ──────────────────
 * Reactive Zustand store that mirrors `GET /admin/auth/permissions` and
 * exposes a fast `hasPermission(resource, action)` selector.
 *
 * Why Zustand (not React Query)?
 *   - The set is consumed by hundreds of callsites (`<PermissionGate>`,
 *     navigation items, route guards, page-level checks). Reading from a
 *     React Query cache works but adds rerenders for unrelated keys.
 *   - We need an imperative `hasPermission` we can call inside event
 *     handlers without subscribing.
 *
 * Loading model
 *   The auth provider triggers `loadPermissions()` once after the admin
 *   profile is verified. Subsequent role mutations call
 *   `refreshPermissions()` to re-fetch.
 */
import { create } from 'zustand';
import {
  getEffectivePermissions,
} from './rbac-api';
import type {
  RbacAction,
  RbacEffectivePermissionsResponse,
  RbacPermission,
} from './rbac-types';

interface PermissionState {
  /** True when the initial fetch (post-auth) has completed. */
  loaded: boolean;
  /** True while a fetch is in flight. */
  loading: boolean;
  /** Last-known permission set, indexed for O(1) lookups. */
  granted: ReadonlySet<string>;
  /** Set when the backend signals the admin must rotate their password. */
  mustChangePassword: boolean;
  /** Legacy enum role ('DEV' / 'ADMIN' / 'USER'). */
  role: string | null;
  /** Optional pointer to the custom RBAC role assigned to this admin. */
  rbacRoleId: string | null;
  /** Last error (if any). */
  error: Error | null;

  loadPermissions: () => Promise<void>;
  refreshPermissions: () => Promise<void>;
  reset: () => void;
  hasPermission: (resource: string, action: RbacAction) => boolean;
}

function permissionToToken(p: RbacPermission): string {
  return `${p.resource}:${p.action}`;
}

/**
 * The permission check itself, as a pure function of the two fields it reads.
 *
 * `hasPermission` below is a stable function that reads the store through
 * `get()`, so a component selecting IT (`usePermissionStore((s) =>
 * s.hasPermission)`) never re-renders when the grants change — it keeps the
 * same reference forever. A component that has to follow the grants selects
 * `granted` and `role` and asks this instead.
 */
export function holdsPermission(
  state: { readonly role: string | null; readonly granted: ReadonlySet<string> },
  resource: string,
  action: string,
): boolean {
  // DEV admins always pass; this mirrors the backend RBAC service so
  // the UI never hides things a DEV could open through the API anyway.
  if (state.role === 'DEV') return true;
  return state.granted.has(`${resource}:${action}`);
}

function applyResponse(
  set: (p: Partial<PermissionState>) => void,
  response: RbacEffectivePermissionsResponse,
): void {
  const granted = new Set<string>(response.permissions.map(permissionToToken));
  set({
    loaded: true,
    loading: false,
    granted,
    mustChangePassword: response.mustChangePassword,
    role: response.role,
    rbacRoleId: response.rbacRoleId,
    error: null,
  });
}

function toError(err: unknown, fallback: string): Error {
  return err instanceof Error ? err : new Error(fallback);
}

const INITIAL: Omit<
  PermissionState,
  'loadPermissions' | 'refreshPermissions' | 'reset' | 'hasPermission'
> = {
  loaded: false,
  loading: false,
  granted: new Set<string>(),
  mustChangePassword: false,
  role: null,
  rbacRoleId: null,
  error: null,
};

export const usePermissionStore = create<PermissionState>((set, get) => ({
  ...INITIAL,
  loadPermissions: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const data = await getEffectivePermissions();
      applyResponse(set, data);
    } catch (err) {
      const error = toError(err, 'Failed to load permissions');
      set({ loading: false, error });
      throw error;
    }
  },
  refreshPermissions: async () => {
    set({ loading: true });
    try {
      const data = await getEffectivePermissions();
      applyResponse(set, data);
    } catch (err) {
      const error = toError(err, 'Failed to load permissions');
      set({ loading: false, error });
    }
  },
  reset: () => {
    set({ ...INITIAL });
  },
  hasPermission: (resource: string, action: RbacAction) => holdsPermission(get(), resource, action),
}));
