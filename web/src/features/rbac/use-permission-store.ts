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
      set({ loading: false, error: err instanceof Error ? err : new Error('Failed to load permissions') });
    }
  },
  refreshPermissions: async () => {
    set({ loading: true });
    try {
      const data = await getEffectivePermissions();
      applyResponse(set, data);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err : new Error('Failed to load permissions') });
    }
  },
  reset: () => {
    set({ ...INITIAL });
  },
  hasPermission: (resource: string, action: RbacAction) => {
    const state = get();
    // DEV admins always pass; this mirrors the backend RBAC service so
    // the UI never hides things a DEV could open through the API anyway.
    if (state.role === 'DEV') return true;
    return state.granted.has(`${resource}:${action}`);
  },
}));
