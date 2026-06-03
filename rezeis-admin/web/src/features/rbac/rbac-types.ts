/**
 * Frontend wire types for the RBAC backend.
 *
 * Kept here (not under `lib/`) so the rest of the app can depend on a
 * single `@/features/rbac` boundary that ships:
 *   - the permission store (`usePermissionStore`)
 *   - the `<PermissionGate>` component
 *   - the role-management page
 *   - shared types
 */

export type RbacAction =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'bulk_operations'
  | 'resolve'
  | 'run'
  | 'export'
  | 'import';

export interface RbacPermission {
  resource: string;
  action: RbacAction;
}

export interface RbacRoleListItem {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  permissionsCount: number;
  assignedAdminCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RbacRole {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  permissions: RbacPermission[];
  assignedAdminCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RbacResourceCatalog {
  actions: RbacAction[];
  resources: Record<string, RbacAction[]>;
}

/** Response from `GET /admin/auth/permissions`. */
export interface RbacEffectivePermissionsResponse {
  permissions: RbacPermission[];
  mustChangePassword: boolean;
  rbacRoleId: string | null;
  /** Legacy enum role ('DEV', 'ADMIN', 'USER'). */
  role: string;
}
