import apiClient from './client';
import type {
  Banner,
  CreateBannerDTO,
  UpdateBannerDTO,
  GetBannersParams,
  BannerPosition,
  PaginatedResult,
  ApiResponse,
  BannerStatistics,
} from '@/types/entity.types';

/**
 * Banners API service
 * Handles all API calls related to banner management
 */

/**
 * Get all banners with optional filters
 * @param params - Filter and pagination params
 * @returns Promise with paginated banners
 */
export async function getAll(params?: GetBannersParams): Promise<PaginatedResult<Banner>> {
  const response = await apiClient.get<ApiResponse<PaginatedResult<Banner>>>('/api/banners', {
    params,
  });
  return response.data.data;
}

/**
 * Get all active banners
 * @returns Promise with array of active banners
 */
export async function getActive(): Promise<Banner[]> {
  const response = await apiClient.get<ApiResponse<Banner[]>>('/api/banners/active');
  return response.data.data;
}

/**
 * Get active banners by position
 * @param position - Banner position
 * @returns Promise with array of active banners for the position
 */
export async function getByPosition(position: BannerPosition): Promise<Banner[]> {
  const response = await apiClient.get<ApiResponse<Banner[]>>('/api/banners/by-position', {
    params: { position },
  });
  return response.data.data;
}

/**
 * Get banner by ID
 * @param id - Banner ID
 * @returns Promise with banner data
 */
export async function getById(id: string): Promise<Banner> {
  const response = await apiClient.get<ApiResponse<Banner>>(`/api/banners/${id}`);
  return response.data.data;
}

/**
 * Create new banner
 * @param data - Banner creation data
 * @returns Promise with created banner
 */
export async function create(data: CreateBannerDTO): Promise<Banner> {
  const response = await apiClient.post<ApiResponse<Banner>>('/api/banners', data);
  return response.data.data;
}

/**
 * Update banner
 * @param id - Banner ID
 * @param data - Banner update data
 * @returns Promise with updated banner
 */
export async function update(id: string, data: UpdateBannerDTO): Promise<Banner> {
  const response = await apiClient.patch<ApiResponse<Banner>>(`/api/banners/${id}`, data);
  return response.data.data;
}

/**
 * Delete banner
 * @param id - Banner ID
 * @returns Promise that resolves when banner is deleted
 */
export async function deleteBanner(id: string): Promise<void> {
  await apiClient.delete<ApiResponse<void>>(`/api/banners/${id}`);
}

/**
 * Toggle banner active status
 * @param id - Banner ID
 * @returns Promise with updated banner
 */
export async function toggleActive(id: string): Promise<Banner> {
  const banner = await getById(id);
  const response = await apiClient.patch<ApiResponse<Banner>>(`/api/banners/${id}`, {
    isActive: !banner.isActive,
  });
  return response.data.data;
}

/**
 * Track banner click
 * @param id - Banner ID
 * @returns Promise with updated click statistics
 */
export async function trackClick(id: string): Promise<{ bannerId: string; clickCount: number; impressionCount: number }> {
  const response = await apiClient.post<ApiResponse<{ bannerId: string; clickCount: number; impressionCount: number }>>(`/api/banners/${id}/click`);
  return response.data.data;
}

/**
 * Track banner impression
 * @param id - Banner ID
 * @returns Promise with updated impression statistics
 */
export async function trackImpression(id: string): Promise<{ bannerId: string; clickCount: number; impressionCount: number }> {
  const response = await apiClient.post<ApiResponse<{ bannerId: string; clickCount: number; impressionCount: number }>>(`/api/banners/${id}/impression`);
  return response.data.data;
}

/**
 * Get banner statistics
 * @param id - Banner ID
 * @returns Promise with banner statistics including CTR
 */
export async function getStatistics(id: string): Promise<BannerStatistics> {
  const response = await apiClient.get<ApiResponse<BannerStatistics>>(`/api/banners/${id}/statistics`);
  return response.data.data;
}

/**
 * Banners service object
 */
export const bannersService = {
  getAll,
  getActive,
  getByPosition,
  getById,
  create,
  update,
  delete: deleteBanner,
  toggleActive,
  trackClick,
  trackImpression,
  getStatistics,
};
