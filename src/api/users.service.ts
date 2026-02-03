import apiClient from './client';
import type {
  User,
  CreateUserDTO,
  UpdateUserDTO,
  GetUsersParams,
  PaginatedResult,
  ApiResponse,
  Subscription,
  UserDetails,
} from '../types/entity.types';

/**
 * Users API service
 * Handles all API calls related to user management
 */

/**
 * Get users with pagination and filters
 * @param params - Query parameters for filtering and pagination
 * @returns Promise with paginated users
 */
export async function getUsers(params: GetUsersParams = {}): Promise<PaginatedResult<User>> {
  const response = await apiClient.get<ApiResponse<PaginatedResult<User>>>('/api/users', {
    params,
  });
  return response.data.data;
}

/**
 * Get user by ID
 * @param id - User ID
 * @returns Promise with user data
 */
export async function getUser(id: string): Promise<User> {
  const response = await apiClient.get<ApiResponse<User>>(`/api/users/${id}`);
  return response.data.data;
}

/**
 * Create new user
 * @param data - User creation data
 * @returns Promise with created user
 */
export async function createUser(data: CreateUserDTO): Promise<User> {
  const response = await apiClient.post<ApiResponse<User>>('/api/users', data);
  return response.data.data;
}

/**
 * Update user
 * @param id - User ID
 * @param data - User update data
 * @returns Promise with updated user
 */
export async function updateUser(id: string, data: UpdateUserDTO): Promise<User> {
  const response = await apiClient.put<ApiResponse<User>>(`/api/users/${id}`, data);
  return response.data.data;
}

/**
 * Delete user
 * @param id - User ID
 * @returns Promise that resolves when user is deleted
 */
export async function deleteUser(id: string): Promise<void> {
  await apiClient.delete<ApiResponse<void>>(`/api/users/${id}`);
}

/**
 * Block user
 * @param id - User ID
 * @returns Promise with updated user
 */
export async function blockUser(id: string): Promise<User> {
  const response = await apiClient.post<ApiResponse<User>>(`/api/users/${id}/block`);
  return response.data.data;
}

/**
 * Unblock user
 * @param id - User ID
 * @returns Promise with updated user
 */
export async function unblockUser(id: string): Promise<User> {
  const response = await apiClient.post<ApiResponse<User>>(`/api/users/${id}/unblock`);
  return response.data.data;
}

/**
 * Get user subscriptions
 * @param id - User ID
 * @returns Promise with array of subscriptions
 */
export async function getUserSubscriptions(id: string): Promise<Subscription[]> {
  const response = await apiClient.get<ApiResponse<Subscription[]>>(`/api/users/${id}/subscriptions`);
  return response.data.data;
}

/**
 * Get user details with all related data
 * @param id - User ID
 * @returns Promise with user details
 */
export async function getUserDetails(id: string): Promise<UserDetails> {
  const response = await apiClient.get<ApiResponse<UserDetails>>(`/api/users/${id}/details`);
  return response.data.data;
}

/**
 * Users service object
 */
export const usersService = {
  getUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  blockUser,
  unblockUser,
  getUserSubscriptions,
  getUserDetails,
};
