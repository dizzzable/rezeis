/**
 * Trial API Service
 * Handles all API calls related to trial subscriptions
 */

import apiClient from './client';

/**
 * Trial eligibility response interface
 */
interface TrialEligibilityResponse {
  eligible: boolean;
  reason?: string;
  trial_days?: number;
}

/**
 * Trial creation response interface
 */
interface TrialCreationResponse {
  success: boolean;
  subscription?: {
    id: string;
    plan: { name: string };
    end_date: string;
  };
  error?: string;
}

/**
 * Trial API service object
 */
export const trialApi = {
  /**
   * Check trial eligibility
   */
  async checkEligibility(): Promise<TrialEligibilityResponse> {
    const response = await apiClient.get<TrialEligibilityResponse>(
      '/api/client/subscriptions/enhanced/trial/eligibility'
    );
    return response.data;
  },

  /**
   * Create a trial subscription
   */
  async createTrial(deviceType?: string): Promise<TrialCreationResponse> {
    const response = await apiClient.post<TrialCreationResponse>(
      '/api/client/subscriptions/enhanced/trial',
      { deviceType }
    );
    return response.data;
  },
};

export default trialApi;
