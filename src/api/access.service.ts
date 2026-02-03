import apiClient from './client';
import type {
  Admin,
  CreateAdminDTO,
  GetAdminsParams,
  PaginatedResult,
  ApiResponse,
  AdminRole,
} from '../types/entity.types';

/**
 * Access API service
 * Handles all API calls related to access management
 */

/**
 * Get admins with pagination and filters
 * @param params - Query parameters for filtering and pagination
 * @returns Promise with paginated admins
 */
export async function getAdmins(params: GetAdminsParams = {}): Promise<PaginatedResult<Admin>> {
  const response = await apiClient.get<ApiResponse<PaginatedResult<Admin>>>('/api/access/admins', {
    params,
  });
  return response.data.data;
}

/**
 * Get admin by ID
 * @param id - Admin ID
 * @returns Promise with admin data
 */
export async function getAdmin(id: string): Promise<Admin> {
  const response = await apiClient.get<ApiResponse<Admin>>(`/api/access/admins/${id}`);
  return response.data.data;
}

/**
 * Create new admin
 * @param data - Admin creation data
 * @returns Promise with created admin
 */
export async function addAdmin(data: CreateAdminDTO): Promise<Admin> {
  const response = await apiClient.post<ApiResponse<Admin>>('/api/access/admins', data);
  return response.data.data;
}

/**
 * Update admin role
 * @param id - Admin ID
 * @param role - New role
 * @returns Promise with updated admin
 */
export async function updateRole(id: string, role: AdminRole): Promise<Admin> {
  const response = await apiClient.patch<ApiResponse<Admin>>(`/api/access/admins/${id}/role`, {
    role,
  });
  return response.data.data;
}

/**
 * Remove admin
 * @param id - Admin ID
 * @returns Promise that resolves when admin is deleted
 */
export async function removeAdmin(id: string): Promise<void> {
  await apiClient.delete<ApiResponse<void>>(`/api/access/admins/${id}`);
}

/**
 * Access service object
 */
export const accessService = {
  getAdmins,
  getAdmin,
  addAdmin,
  updateRole,
  removeAdmin,
};
