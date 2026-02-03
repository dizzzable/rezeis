import apiClient from './client';
import type {
  Broadcast,
  BroadcastWithButtons,
  CreateBroadcastInput,
  UpdateBroadcastInput,
  BroadcastAudience,
  AudienceCount,
  PaginatedResult,
  ApiResponse,
} from '@/types/entity.types';

/**
 * Broadcast service for managing mass messaging
 */
class BroadcastService {
  /**
   * Get paginated broadcasts with optional filters
   */
  async getBroadcasts(params: {
    page?: number;
    limit?: number;
    status?: string;
    audience?: string;
  }): Promise<PaginatedResult<Broadcast>> {
    const response = await apiClient.get<ApiResponse<PaginatedResult<Broadcast>>>('/broadcasts', {
      params,
    });
    return response.data.data;
  }

  /**
   * Get broadcast by ID with buttons
   */
  async getBroadcast(id: string): Promise<{ broadcast: Broadcast; buttons: BroadcastWithButtons['buttons'] }> {
    const response = await apiClient.get<ApiResponse<{ broadcast: Broadcast; buttons: BroadcastWithButtons['buttons'] }>>(`/broadcasts/${id}`);
    return response.data.data;
  }

  /**
   * Create new broadcast
   */
  async createBroadcast(data: CreateBroadcastInput): Promise<{ broadcast: Broadcast; buttons: BroadcastWithButtons['buttons'] }> {
    const response = await apiClient.post<ApiResponse<{ broadcast: Broadcast; buttons: BroadcastWithButtons['buttons'] }>>('/broadcasts', data);
    return response.data.data;
  }

  /**
   * Update broadcast
   */
  async updateBroadcast(
    id: string,
    data: UpdateBroadcastInput
  ): Promise<{ broadcast: Broadcast; buttons: BroadcastWithButtons['buttons'] }> {
    const response = await apiClient.patch<ApiResponse<{ broadcast: Broadcast; buttons: BroadcastWithButtons['buttons'] }>>(`/broadcasts/${id}`, data);
    return response.data.data;
  }

  /**
   * Delete broadcast
   */
  async deleteBroadcast(id: string): Promise<void> {
    await apiClient.delete(`/broadcasts/${id}`);
  }

  /**
   * Send broadcast to audience
   */
  async sendBroadcast(id: string): Promise<{
    broadcastId: string;
    status: string;
    recipientsCount: number;
    message: string;
  }> {
    const response = await apiClient.post<ApiResponse<{
      broadcastId: string;
      status: string;
      recipientsCount: number;
      message: string;
    }>>(`/broadcasts/${id}/send`);
    return response.data.data;
  }

  /**
   * Send preview to admin
   */
  async previewBroadcast(id: string, telegramId: string): Promise<void> {
    await apiClient.post(`/broadcasts/${id}/preview`, { telegramId });
  }

  /**
   * Get audience count for targeting
   */
  async getAudience(params: {
    audience: BroadcastAudience;
    planId?: string;
  }): Promise<AudienceCount> {
    const response = await apiClient.get<ApiResponse<AudienceCount>>('/broadcasts/audience', {
      params,
    });
    return response.data.data;
  }
}

export const broadcastService = new BroadcastService();
