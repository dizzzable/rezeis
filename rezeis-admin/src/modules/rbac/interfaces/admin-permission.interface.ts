import { RbacAction } from '../rbac.resources';

/** Single (resource × action) grant on a role. */
export interface AdminPermissionInterface {
  readonly resource: string;
  readonly action: RbacAction;
}

/** Public role view returned by RBAC controllers. */
export interface AdminRoleInterface {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly permissions: readonly AdminPermissionInterface[];
  readonly assignedAdminCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Lightweight version returned in list endpoints — drops the permission
 * matrix to keep payloads small. Use `GET /admin/rbac/roles/:id` to fetch
 * the full version.
 */
export interface AdminRoleListItemInterface {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly permissionsCount: number;
  readonly assignedAdminCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
