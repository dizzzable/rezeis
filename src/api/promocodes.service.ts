import apiClient from './client';
import type {
  Promocode,
  CreatePromocodeDTO,
  UpdatePromocodeDTO,
  GetPromocodesParams,
  PaginatedResult,
  ApiResponse,
  ValidatePromocodeResponse,
  ApplyPromocodeResponse,
} from '@/types/entity.types';

/**
 * Promocodes API service
 * Handles all API calls related to promocode management
 */

/**
 * Get all promocodes with optional filters
 * @param params - Filter and pagination params
 * @returns Promise with paginated promocodes
 */
export async function getPromocodes(params?: GetPromocodesParams): Promise<PaginatedResult<Promocode>> {
  const response = await apiClient.get<ApiResponse<PaginatedResult<Promocode>>>('/api/promocodes', {
    params,
  });
  return response.data.data;
}

/**
 * Get all promocodes without pagination
 * @returns Promise with array of all promocodes
 */
export async function getAllPromocodes(): Promise<Promocode[]> {
  const response = await apiClient.get<ApiResponse<Promocode[]>>('/api/promocodes/all');
  return response.data.data;
}

/**
 * Get promocode by ID
 * @param id - Promocode ID
 * @returns Promise with promocode data
 */
export async function getPromocode(id: string): Promise<Promocode> {
  const response = await apiClient.get<ApiResponse<Promocode>>(`/api/promocodes/${id}`);
  return response.data.data;
}

/**
 * Get promocode by code
 * @param code - Promocode code
 * @returns Promise with promocode data
 */
export async function getPromocodeByCode(code: string): Promise<Promocode> {
  const response = await apiClient.get<ApiResponse<Promocode>>(`/api/promocodes/code/${code}`);
  return response.data.data;
}

/**
 * Create new promocode
 * @param data - Promocode creation data
 * @returns Promise with created promocode
 */
export async function createPromocode(data: CreatePromocodeDTO): Promise<Promocode> {
  const response = await apiClient.post<ApiResponse<Promocode>>('/api/promocodes', data);
  return response.data.data;
}

/**
 * Update promocode
 * @param id - Promocode ID
 * @param data - Promocode update data
 * @returns Promise with updated promocode
 */
export async function updatePromocode(id: string, data: UpdatePromocodeDTO): Promise<Promocode> {
  const response = await apiClient.put<ApiResponse<Promocode>>(`/api/promocodes/${id}`, data);
  return response.data.data;
}

/**
 * Delete promocode
 * @param id - Promocode ID
 * @returns Promise that resolves when promocode is deleted
 */
export async function deletePromocode(id: string): Promise<void> {
  await apiClient.delete<ApiResponse<void>>(`/api/promocodes/${id}`);
}

/**
 * Toggle promocode active status
 * @param id - Promocode ID
 * @returns Promise with updated promocode
 */
export async function togglePromocodeActive(id: string): Promise<Promocode> {
  const response = await apiClient.post<ApiResponse<Promocode>>(`/api/promocodes/${id}/toggle`);
  return response.data.data;
}

/**
 * Validate promocode
 * @param code - Promocode code to validate
 * @returns Promise with validation result
 */
export async function validatePromocode(code: string): Promise<ValidatePromocodeResponse> {
  const response = await apiClient.post<ApiResponse<ValidatePromocodeResponse>>('/api/promocodes/validate', {
    code,
  });
  return response.data.data;
}

/**
 * Apply promocode to get discount
 * @param code - Promocode code
 * @param originalPrice - Original price before discount
 * @returns Promise with discount calculation
 */
export async function applyPromocode(code: string, originalPrice: number): Promise<ApplyPromocodeResponse> {
  const response = await apiClient.post<ApiResponse<ApplyPromocodeResponse>>('/api/promocodes/apply', {
    code,
    originalPrice,
  });
  return response.data.data;
}

/**
 * Promocodes service object
 */
export const promocodesService = {
  getPromocodes,
  getAllPromocodes,
  getPromocode,
  getPromocodeByCode,
  createPromocode,
  updatePromocode,
  deletePromocode,
  toggleActive: togglePromocodeActive,
  validate: validatePromocode,
  apply: applyPromocode,
};
