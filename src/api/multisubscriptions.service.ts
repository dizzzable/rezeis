import apiClient from './client';
import type {
  Multisubscription,
  CreateMultisubscriptionInput,
  UpdateMultisubscriptionInput,
  MultisubscriptionStatistics,
  GetMultisubscriptionsParams
} from '@/types/entity.types';

export interface MultisubscriptionsResponse {
  data: Multisubscription[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Multisubscriptions API service
 */
class MultisubscriptionsService {
  /**
   * Get paginated multisubscriptions with filters
   */
  async getMultisubscriptions(params: GetMultisubscriptionsParams = {}): Promise<MultisubscriptionsResponse> {
    const response = await apiClient.get<{ success: boolean; data: MultisubscriptionsResponse }>('/multisubscriptions', {
      params,
    });
    return response.data.data;
  }

  /**
   * Get multisubscription by ID
   */
  async getMultisubscription(id: string): Promise<Multisubscription> {
    const response = await apiClient.get<{ success: boolean; data: Multisubscription }>(`/multisubscriptions/${id}`);
    return response.data.data;
  }

  /**
   * Get multisubscriptions by user ID
   */
  async getMultisubscriptionsByUser(userId: string): Promise<Multisubscription[]> {
    const response = await apiClient.get<{ success: boolean; data: Multisubscription[] }>(`/multisubscriptions/user/${userId}`);
    return response.data.data;
  }

  /**
   * Create new multisubscription
   */
  async createMultisubscription(data: CreateMultisubscriptionInput): Promise<Multisubscription> {
    const response = await apiClient.post<{ success: boolean; data: Multisubscription }>('/multisubscriptions', data);
    return response.data.data;
  }

  /**
   * Update multisubscription
   */
  async updateMultisubscription(id: string, data: UpdateMultisubscriptionInput): Promise<Multisubscription> {
    const response = await apiClient.patch<{ success: boolean; data: Multisubscription }>(`/multisubscriptions/${id}`, data);
    return response.data.data;
  }

  /**
   * Delete multisubscription
   */
  async deleteMultisubscription(id: string): Promise<void> {
    await apiClient.delete(`/multisubscriptions/${id}`);
  }

  /**
   * Toggle multisubscription active status
   */
  async toggleMultisubscriptionStatus(id: string, isActive: boolean): Promise<Multisubscription> {
    const response = await apiClient.post<{ success: boolean; data: Multisubscription }>(`/multisubscriptions/${id}/toggle`, {
      isActive,
    });
    return response.data.data;
  }

  /**
   * Get multisubscription statistics
   */
  async getStatistics(): Promise<MultisubscriptionStatistics> {
    const response = await apiClient.get<{ success: boolean; data: MultisubscriptionStatistics }>('/multisubscriptions/statistics');
    return response.data.data;
  }
}

export const multisubscriptionsService = new MultisubscriptionsService();
