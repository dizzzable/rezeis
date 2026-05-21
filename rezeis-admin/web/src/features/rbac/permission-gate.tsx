import type { ReactNode } from 'react';
import { usePermissionStore } from './use-permission-store';
import type { RbacAction } from './rbac-types';

interface PermissionGateProps {
  /** Resource key from `RBAC_RESOURCES` (e.g. `"payments"`). */
  resource: string;
  /** Required action. */
  action: RbacAction;
  /** Rendered when the admin has the permission. */
  children: ReactNode;
  /**
   * Rendered when the admin lacks the permission. Defaults to nothing,
   * which is the right choice for navigation entries / inline buttons.
   * Pass an explicit fallback for whole-page surfaces.
   */
  fallback?: ReactNode;
  /**
   * When `true` and permissions have not finished loading yet, render
   * `fallback`. Default `false` keeps optimistic rendering on first
   * paint to avoid a flash of empty navigation while the auth probe
   * resolves.
   */
  hideWhileLoading?: boolean;
}

/**
 * Conditional renderer that consults the permission store. Use for any
 * UI affordance that should be invisible to admins without the matching
 * RBAC grant.
 *
 * Important: the gate is a UX hint, not a security boundary. The
 * authoritative check still happens server-side via `RbacGuard`.
 */
export function PermissionGate({
  resource,
  action,
  children,
  fallback = null,
  hideWhileLoading = false,
}: PermissionGateProps) {
  const loaded = usePermissionStore((s) => s.loaded);
  const allowed = usePermissionStore((s) => s.hasPermission(resource, action));
  if (!loaded && hideWhileLoading) return <>{fallback}</>;
  if (!allowed) return <>{fallback}</>;
  return <>{children}</>;
}

/**
 * Hook variant — useful inside components that already need to call
 * `usePermissionStore` for other reasons.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useHasPermission(resource: string, action: RbacAction): boolean {
  return usePermissionStore((s) => s.hasPermission(resource, action));
}
