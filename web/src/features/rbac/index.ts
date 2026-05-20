/**
 * Public surface for the RBAC feature. Other parts of the app should
 * import from this barrel rather than reaching into the implementation
 * files — it keeps the API stable when the internals get refactored.
 */
export {
  usePermissionStore,
} from './use-permission-store';
export {
  PermissionGate,
  useHasPermission,
} from './permission-gate';
export type {
  RbacAction,
  RbacPermission,
  RbacRole,
  RbacRoleListItem,
  RbacResourceCatalog,
  RbacEffectivePermissionsResponse,
} from './rbac-types';
export {
  getResourceCatalog,
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  syncSystemRoles,
  getEffectivePermissions,
  changePassword,
} from './rbac-api';
