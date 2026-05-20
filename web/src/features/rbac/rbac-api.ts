import { api } from '@/lib/api';
import type {
  RbacEffectivePermissionsResponse,
  RbacResourceCatalog,
  RbacRole,
  RbacRoleListItem,
  RbacPermission,
} from './rbac-types';

const RBAC_BASE = '/admin/rbac';

/** Fetches the resource × action catalog used by the role editor. */
export async function getResourceCatalog(): Promise<RbacResourceCatalog> {
  const res = await api.get<RbacResourceCatalog>(`${RBAC_BASE}/resources`);
  return res.data;
}

/** Lists every role (lightweight payload — no permission matrix). */
export async function listRoles(): Promise<RbacRoleListItem[]> {
  const res = await api.get<RbacRoleListItem[]>(`${RBAC_BASE}/roles`);
  return res.data;
}

/** Fetches a single role with its full permission matrix. */
export async function getRole(id: string): Promise<RbacRole> {
  const res = await api.get<RbacRole>(`${RBAC_BASE}/roles/${id}`);
  return res.data;
}

export interface UpsertRolePayload {
  name?: string; // only for create
  displayName: string;
  description?: string | null;
  permissions: RbacPermission[];
}

/** Creates a new custom role. */
export async function createRole(payload: UpsertRolePayload & { name: string }): Promise<RbacRole> {
  const res = await api.post<RbacRole>(`${RBAC_BASE}/roles`, payload);
  return res.data;
}

/** Replaces a role's display info and (for non-system roles) its permissions. */
export async function updateRole(id: string, payload: UpsertRolePayload): Promise<RbacRole> {
  const res = await api.put<RbacRole>(`${RBAC_BASE}/roles/${id}`, payload);
  return res.data;
}

/** Deletes a non-system role that is not assigned to any admin. */
export async function deleteRole(id: string): Promise<void> {
  await api.delete(`${RBAC_BASE}/roles/${id}`);
}

/** Re-runs the system-role bootstrap (idempotent). */
export async function syncSystemRoles(): Promise<void> {
  await api.post(`${RBAC_BASE}/roles/sync-system`);
}

/** Fetches the effective permission set for the current admin. */
export async function getEffectivePermissions(): Promise<RbacEffectivePermissionsResponse> {
  const res = await api.get<RbacEffectivePermissionsResponse>('/admin/auth/permissions');
  return res.data;
}

export interface ChangePasswordPayload {
  currentPassword: string;
  newPassword: string;
}

/** Rotates the authenticated admin's password (clears mustChangePassword). */
export async function changePassword(payload: ChangePasswordPayload): Promise<void> {
  // The backend returns a fresh token; the auth provider picks it up
  // from the response when the caller chooses to. Here we only care
  // about the side-effect.
  await api.post('/admin/auth/password', payload);
}
