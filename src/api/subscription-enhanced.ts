/**
 * Subscription Enhanced API Service
 * Handles all API calls related to enhanced subscription management
 */

import apiClient from './client';

/**
 * Enhanced subscription interface
 */
interface EnhancedSubscription {
  id: string;
  plan: { name: string; id: string };
  end_date: string;
  status: string;
  device_type?: string;
  is_trial: boolean;
  created_at: string;
}

/**
 * Bulk renewal calculation response interface
 */
interface BulkRenewalCalculationResponse {
  totalAmount: number;
  totalDiscount: number;
  finalAmount: number;
}

/**
 * Bulk renewal process response interface
 */
interface BulkRenewalProcessResponse {
  success: boolean;
  paymentUrl?: string;
  transactionId?: string;
  error?: string;
}

/**
 * Device compatible plan interface
 */
interface DeviceCompatiblePlan {
  id: string;
  name: string;
  description: string;
  basePrice: number;
  deviceTypes: string[];
}

/**
 * Set current subscription request interface
 */
interface SetCurrentSubscriptionRequest {
  subscriptionId: string;
}

/**
 * Set device type request interface
 */
interface SetDeviceTypeRequest {
  deviceType: string;
}

/**
 * Bulk renewal calculation request interface
 */
interface BulkRenewalCalculationRequest {
  subscriptionIds: string[];
  durationId: string;
  promocode?: string;
}

/**
 * Bulk renewal process request interface
 */
interface BulkRenewalProcessRequest {
  subscriptionIds: string[];
  durationId: string;
  gatewayId: string;
  promocode?: string;
}

/**
 * Subscription Enhanced API service object
 */
export const subscriptionApi = {
  /**
   * Get all enhanced subscriptions
   */
  async getAll(): Promise<EnhancedSubscription[]> {
    const response = await apiClient.get<EnhancedSubscription[]>(
      '/api/client/subscriptions/enhanced'
    );
    return response.data;
  },

  /**
   * Get current active subscription
   */
  async getCurrent(): Promise<EnhancedSubscription | null> {
    try {
      const response = await apiClient.get<EnhancedSubscription>(
        '/api/client/subscriptions/enhanced/current'
      );
      return response.data;
    } catch {
      return null;
    }
  },

  /**
   * Set current subscription
   */
  async setCurrent(subscriptionId: string): Promise<void> {
    await apiClient.post('/api/client/subscriptions/enhanced/current', {
      subscriptionId,
    } as SetCurrentSubscriptionRequest);
  },

  /**
   * Set device type for subscription
   */
  async setDeviceType(subscriptionId: string, deviceType: string): Promise<void> {
    await apiClient.post(`/api/client/subscriptions/enhanced/${subscriptionId}/device`, {
      deviceType,
    } as SetDeviceTypeRequest);
  },

  /**
   * Calculate bulk renewal price
   */
  async calculateBulkRenewal(
    subscriptionIds: string[],
    durationId: string,
    promocode?: string
  ): Promise<BulkRenewalCalculationResponse> {
    const response = await apiClient.post<BulkRenewalCalculationResponse>(
      '/api/client/subscriptions/enhanced/bulk-renewal/calculate',
      { subscriptionIds, durationId, promocode } as BulkRenewalCalculationRequest
    );
    return response.data;
  },

  /**
   * Process bulk renewal
   */
  async processBulkRenewal(
    subscriptionIds: string[],
    durationId: string,
    gatewayId: string,
    promocode?: string
  ): Promise<BulkRenewalProcessResponse> {
    const response = await apiClient.post<BulkRenewalProcessResponse>(
      '/api/client/subscriptions/enhanced/bulk-renewal',
      { subscriptionIds, durationId, gatewayId, promocode } as BulkRenewalProcessRequest
    );
    return response.data;
  },

  /**
   * Get plans compatible with device type
   */
  async getDeviceCompatiblePlans(deviceType: string): Promise<DeviceCompatiblePlan[]> {
    const response = await apiClient.get<DeviceCompatiblePlan[]>(
      `/api/client/subscriptions/enhanced/plans/compatible?deviceType=${deviceType}`
    );
    return response.data;
  },
};

export default subscriptionApi;
