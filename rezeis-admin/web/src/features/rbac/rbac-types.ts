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

/**
 * Every action the backend's RBAC catalog understands.
 *
 * A VALUE, not a hand-written union, and that is the point. This list is a
 * copy of `src/modules/rbac/rbac.resources.ts`'s `RBAC_ACTIONS`, and a copy
 * drifts: `view_secrets` was added to the backend and never added here, so
 * `useHasPermission('payment_gateways', 'view_secrets')` — a permission the
 * server really enforces — was a TYPE ERROR in the panel. Nothing broke only
 * because `gateway-settings-page.tsx` reads the server's masking verdict off
 * the payload instead of gating on the token. The next person to try would
 * have concluded the permission did not exist.
 *
 * As a union alone, no test could read it. As a const the union is derived
 * from, `rbac-catalog-parity.test.ts` compares it against the backend's own
 * array in BOTH directions and names whatever has drifted. The dangerous
 * direction is the second one: a panel gate on an action no role can ever
 * hold hides a feature from everyone, silently and forever.
 *
 * The production bundle is unaffected — every non-test importer of this module
 * uses `import type`, so nothing here is emitted into the app.
 */
export const RBAC_ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'bulk_operations',
  'resolve',
  'run',
  'export',
  'import',
  'archive',
  'enforce',
  'moderate',
  'merge',
  'view_registration',
  'export_registration',
  /** Issuing a payment refund. Separate from `edit` — it moves real money. */
  'refund',
  /**
   * Reading payment gateway credentials in the clear. Separate from `view`,
   * which returns the same gateways with every secret masked — so managing a
   * gateway never requires this. Granted to no system role by default.
   */
  'view_secrets',
] as const;

export type RbacAction = (typeof RBAC_ACTIONS)[number];

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
