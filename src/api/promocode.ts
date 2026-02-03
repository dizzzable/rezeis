/**
 * Promocode API Service
 * Handles all API calls related to promocode management
 */

import apiClient from './client';

/**
 * Promocode validation response interface
 */
interface PromocodeValidationResponse {
  valid: boolean;
  error?: string;
  discount?: { value: number };
  reward?: { description: string };
}

/**
 * Promocode activation response interface
 */
interface PromocodeActivationResponse {
  success: boolean;
  error?: string;
  activation?: {
    reward_applied?: { type: string; value: number; description: string };
  };
}

/**
 * Promocode history item interface
 */
interface PromocodeHistoryItem {
  code: string;
  activated_at: string;
  reward?: { type: string; value: number; description: string };
}

/**
 * Promocode history response interface
 */
interface PromocodeHistoryResponse {
  data: PromocodeHistoryItem[];
  page: number;
  limit: number;
  total: number;
}

/**
 * Available promocode interface
 */
interface AvailablePromocode {
  code: string;
  description: string;
  discount?: { value: number };
  reward?: { type: string; value: number; description: string };
}

/**
 * Promocode API service object
 */
export const promocodeApi = {
  /**
   * Validate a promocode
   */
  async validate(code: string, planId?: string, amount?: number): Promise<PromocodeValidationResponse> {
    const params = new URLSearchParams({ code });
    if (planId) params.append('planId', planId);
    if (amount) params.append('amount', amount.toString());

    const response = await apiClient.get<PromocodeValidationResponse>(
      `/api/client/promocode/validate?${params}`
    );
    return response.data;
  },

  /**
   * Apply a promocode
   */
  async apply(
    code: string,
    subscriptionId?: string,
    amount?: number
  ): Promise<PromocodeActivationResponse> {
    const response = await apiClient.post<PromocodeActivationResponse>(
      '/api/client/promocode/apply',
      { code, subscriptionId, amount }
    );
    return response.data;
  },

  /**
   * Get promocode history
   */
  async getHistory(page = 1, limit = 10): Promise<PromocodeHistoryResponse> {
    const response = await apiClient.get<PromocodeHistoryResponse>(
      `/api/client/promocode/history?page=${page}&limit=${limit}`
    );
    return response.data;
  },

  /**
   * Get available promocodes
   */
  async getAvailable(): Promise<AvailablePromocode[]> {
    const response = await apiClient.get<AvailablePromocode[]>(
      '/api/client/promocode/available'
    );
    return response.data;
  },
};

export default promocodeApi;
