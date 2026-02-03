import apiClient from './client';
import type {
  Partner,
  PartnerEarning,
  PartnerPayout,
  CreatePartnerDTO,
  UpdatePartnerDTO,
  CreatePayoutDTO,
  ProcessPayoutDTO,
  GetPartnersParams,
  PayoutFilters,
  EarningFilters,
  PartnerStats,
  PartnerDashboard,
  PaginatedResult,
  ApiResponse,
} from '../types/entity.types';

/**
 * Partners API service
 * Handles all API calls related to partner program management
 */

/**
 * Get partners with pagination and filters
 * @param params - Query parameters for filtering and pagination
 * @returns Promise with paginated partners
 */
export async function getPartners(params: GetPartnersParams = {}): Promise<PaginatedResult<Partner>> {
  const response = await apiClient.get<ApiResponse<PaginatedResult<Partner>>>('/api/partners', {
    params,
  });
  return response.data.data;
}

/**
 * Get partner statistics
 * @returns Promise with partner statistics
 */
export async function getPartnerStats(): Promise<PartnerStats> {
  const response = await apiClient.get<ApiResponse<PartnerStats>>('/api/partners/stats/overview');
  return response.data.data;
}

/**
 * Get partner by ID
 * @param id - Partner ID
 * @returns Promise with partner data
 */
export async function getPartner(id: string): Promise<Partner> {
  const response = await apiClient.get<ApiResponse<Partner>>(`/api/partners/${id}`);
  return response.data.data;
}

/**
 * Create new partner
 * @param data - Partner creation data
 * @returns Promise with created partner
 */
export async function createPartner(data: CreatePartnerDTO): Promise<Partner> {
  const response = await apiClient.post<ApiResponse<Partner>>('/api/partners', data);
  return response.data.data;
}

/**
 * Update partner
 * @param id - Partner ID
 * @param data - Partner update data
 * @returns Promise with updated partner
 */
export async function updatePartner(id: string, data: UpdatePartnerDTO): Promise<Partner> {
  const response = await apiClient.patch<ApiResponse<Partner>>(`/api/partners/${id}`, data);
  return response.data.data;
}

/**
 * Delete partner
 * @param id - Partner ID
 * @returns Promise that resolves when partner is deleted
 */
export async function deletePartner(id: string): Promise<void> {
  await apiClient.delete<ApiResponse<void>>(`/api/partners/${id}`);
}

/**
 * Approve partner
 * @param id - Partner ID
 * @returns Promise with updated partner
 */
export async function approvePartner(id: string): Promise<Partner> {
  const response = await apiClient.post<ApiResponse<Partner>>(`/api/partners/${id}/approve`);
  return response.data.data;
}

/**
 * Reject partner
 * @param id - Partner ID
 * @returns Promise with updated partner
 */
export async function rejectPartner(id: string): Promise<Partner> {
  const response = await apiClient.post<ApiResponse<Partner>>(`/api/partners/${id}/reject`);
  return response.data.data;
}

/**
 * Suspend partner
 * @param id - Partner ID
 * @returns Promise with updated partner
 */
export async function suspendPartner(id: string): Promise<Partner> {
  const response = await apiClient.post<ApiResponse<Partner>>(`/api/partners/${id}/suspend`);
  return response.data.data;
}

/**
 * Get partner dashboard
 * @param id - Partner ID
 * @returns Promise with partner dashboard data
 */
export async function getPartnerDashboard(id: string): Promise<PartnerDashboard> {
  const response = await apiClient.get<ApiResponse<PartnerDashboard>>(`/api/partners/${id}/dashboard`);
  return response.data.data;
}

/**
 * Get partner earnings
 * @param id - Partner ID
 * @param filters - Filters for earnings
 * @returns Promise with paginated earnings
 */
export async function getPartnerEarnings(
  id: string,
  filters: EarningFilters = {}
): Promise<PaginatedResult<PartnerEarning>> {
  const response = await apiClient.get<ApiResponse<PaginatedResult<PartnerEarning>>>(
    `/api/partners/${id}/earnings`,
    { params: filters }
  );
  return response.data.data;
}

/**
 * Get partner payouts
 * @param id - Partner ID
 * @param filters - Filters for payouts
 * @returns Promise with paginated payouts
 */
export async function getPartnerPayouts(
  id: string,
  filters: PayoutFilters = {}
): Promise<PaginatedResult<PartnerPayout>> {
  const response = await apiClient.get<ApiResponse<PaginatedResult<PartnerPayout>>>(
    `/api/partners/${id}/payouts`,
    { params: filters }
  );
  return response.data.data;
}

/**
 * Create payout
 * @param id - Partner ID
 * @param data - Payout creation data
 * @returns Promise with created payout
 */
export async function createPayout(id: string, data: CreatePayoutDTO): Promise<PartnerPayout> {
  const response = await apiClient.post<ApiResponse<PartnerPayout>>(`/api/partners/${id}/payouts`, data);
  return response.data.data;
}

/**
 * Process payout
 * @param partnerId - Partner ID
 * @param payoutId - Payout ID
 * @param data - Process payout data
 * @returns Promise with updated payout
 */
export async function processPayout(
  partnerId: string,
  payoutId: string,
  data: ProcessPayoutDTO = {}
): Promise<PartnerPayout> {
  const response = await apiClient.post<ApiResponse<PartnerPayout>>(
    `/api/partners/${partnerId}/payouts/${payoutId}/process`,
    data
  );
  return response.data.data;
}

/**
 * Partners service object
 */
export const partnersService = {
  getPartners,
  getPartnerStats,
  getPartner,
  createPartner,
  updatePartner,
  deletePartner,
  approvePartner,
  rejectPartner,
  suspendPartner,
  getPartnerDashboard,
  getPartnerEarnings,
  getPartnerPayouts,
  createPayout,
  processPayout,
};
