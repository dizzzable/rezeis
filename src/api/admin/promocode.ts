import apiClient from '../client';

/**
 * Promocode Admin API service
 * Handles all API calls related to promocode management for administrators
 */

export type PromocodeRewardType = 'DURATION' | 'TRAFFIC' | 'DEVICES' | 'SUBSCRIPTION' | 'PERSONAL_DISCOUNT' | 'PURCHASE_DISCOUNT';
export type PromocodeAvailability = 'ALL' | 'NEW' | 'EXISTING' | 'INVITED' | 'ALLOWED';

export interface Promocode {
  id: string;
  code: string;
  description: string;
  reward_type: PromocodeRewardType;
  reward_value: number;
  discount_percent: number;
  is_active: boolean;
  usage_count: number;
  max_uses: number;
  created_at: string;
  starts_at: string;
  ends_at: string;
}

export interface CreatePromocodeInput {
  code: string;
  description: string;
  reward_type: PromocodeRewardType;
  reward_value: number;
  discount_percent: number;
  max_uses: number;
  availability: PromocodeAvailability;
  starts_at: string;
  ends_at: string;
}

export interface PromocodeActivation {
  id: string;
  promocode_id: string;
  user_id: string;
  used_at: string;
  order_id?: string;
}

export interface PromocodeActivationsResponse {
  activations: PromocodeActivation[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Get all promocodes
 */
export async function getAllPromocodes(): Promise<Promocode[]> {
  const response = await apiClient.get<Promocode[]>('/admin/promocodes');
  return response.data;
}

/**
 * Get promocode by ID
 */
export async function getPromocodeById(id: string): Promise<Promocode> {
  const response = await apiClient.get<Promocode>(`/admin/promocodes/${id}`);
  return response.data;
}

/**
 * Create new promocode
 */
export async function createPromocode(data: CreatePromocodeInput): Promise<Promocode> {
  const response = await apiClient.post<Promocode>('/admin/promocodes', data);
  return response.data;
}

/**
 * Update promocode
 */
export async function updatePromocode(id: string, data: Partial<CreatePromocodeInput>): Promise<Promocode> {
  const response = await apiClient.put<Promocode>(`/admin/promocodes/${id}`, data);
  return response.data;
}

/**
 * Toggle promocode active status
 */
export async function togglePromocode(id: string): Promise<void> {
  await apiClient.post(`/admin/promocodes/${id}/toggle`);
}

/**
 * Delete promocode
 */
export async function deletePromocode(id: string): Promise<void> {
  await apiClient.delete(`/admin/promocodes/${id}`);
}

/**
 * Get promocode activations
 */
export async function getPromocodeActivations(
  id: string,
  page = 1,
  limit = 10
): Promise<PromocodeActivationsResponse> {
  const response = await apiClient.get<PromocodeActivationsResponse>(
    `/admin/promocodes/${id}/activations?page=${page}&limit=${limit}`
  );
  return response.data;
}

/**
 * Promocode Admin API object
 */
export const promocodeAdminApi = {
  getAll: getAllPromocodes,
  getById: getPromocodeById,
  create: createPromocode,
  update: updatePromocode,
  toggle: togglePromocode,
  delete: deletePromocode,
  getActivations: getPromocodeActivations,
};
