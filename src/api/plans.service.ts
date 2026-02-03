import apiClient from './client';
import type {
  Plan,
  CreatePlanDTO,
  UpdatePlanDTO,
  ApiResponse,
} from '../types/entity.types';

/**
 * Plans API service
 * Handles all API calls related to plan management
 */

/**
 * Get all plans
 * @returns Promise with array of all plans
 */
export async function getPlans(): Promise<Plan[]> {
  const response = await apiClient.get<ApiResponse<Plan[]>>('/api/plans');
  return response.data.data;
}

/**
 * Get plan by ID
 * @param id - Plan ID
 * @returns Promise with plan data
 */
export async function getPlan(id: string): Promise<Plan> {
  const response = await apiClient.get<ApiResponse<Plan>>(`/api/plans/${id}`);
  return response.data.data;
}

/**
 * Create new plan
 * @param data - Plan creation data
 * @returns Promise with created plan
 */
export async function createPlan(data: CreatePlanDTO): Promise<Plan> {
  const response = await apiClient.post<ApiResponse<Plan>>('/api/plans', data);
  return response.data.data;
}

/**
 * Update plan
 * @param id - Plan ID
 * @param data - Plan update data
 * @returns Promise with updated plan
 */
export async function updatePlan(id: string, data: UpdatePlanDTO): Promise<Plan> {
  const response = await apiClient.put<ApiResponse<Plan>>(`/api/plans/${id}`, data);
  return response.data.data;
}

/**
 * Delete plan
 * @param id - Plan ID
 * @returns Promise that resolves when plan is deleted
 */
export async function deletePlan(id: string): Promise<void> {
  await apiClient.delete<ApiResponse<void>>(`/api/plans/${id}`);
}

/**
 * Toggle plan active status
 * @param id - Plan ID
 * @returns Promise with updated plan
 */
export async function togglePlan(id: string): Promise<Plan> {
  const response = await apiClient.post<ApiResponse<Plan>>(`/api/plans/${id}/toggle`);
  return response.data.data;
}

/**
 * Plans service object
 */
export const plansService = {
  getPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
  togglePlan,
};
