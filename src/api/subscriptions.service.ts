import apiClient from './client';
import type {
  Subscription,
  CreateSubscriptionDTO,
  UpdateSubscriptionDTO,
  GetSubscriptionsParams,
  PaginatedResult,
  ApiResponse,
} from '../types/entity.types';

/**
 * Subscriptions API service
 * Handles all API calls related to subscription management
 */

/**
 * Get subscriptions with pagination and filters
 * @param params - Query parameters for filtering and pagination
 * @returns Promise with paginated subscriptions
 */
export async function getSubscriptions(params: GetSubscriptionsParams = {}): Promise<PaginatedResult<Subscription>> {
  const response = await apiClient.get<ApiResponse<PaginatedResult<Subscription>>>('/api/subscriptions', {
    params,
  });
  return response.data.data;
}

/**
 * Get subscription by ID
 * @param id - Subscription ID
 * @returns Promise with subscription data
 */
export async function getSubscription(id: string): Promise<Subscription> {
  const response = await apiClient.get<ApiResponse<Subscription>>(`/api/subscriptions/${id}`);
  return response.data.data;
}

/**
 * Create new subscription
 * @param data - Subscription creation data
 * @returns Promise with created subscription
 */
export async function createSubscription(data: CreateSubscriptionDTO): Promise<Subscription> {
  const response = await apiClient.post<ApiResponse<Subscription>>('/api/subscriptions', data);
  return response.data.data;
}

/**
 * Update subscription
 * @param id - Subscription ID
 * @param data - Subscription update data
 * @returns Promise with updated subscription
 */
export async function updateSubscription(id: string, data: UpdateSubscriptionDTO): Promise<Subscription> {
  const response = await apiClient.put<ApiResponse<Subscription>>(`/api/subscriptions/${id}`, data);
  return response.data.data;
}

/**
 * Delete subscription
 * @param id - Subscription ID
 * @returns Promise that resolves when subscription is deleted
 */
export async function deleteSubscription(id: string): Promise<void> {
  await apiClient.delete<ApiResponse<void>>(`/api/subscriptions/${id}`);
}

/**
 * Renew subscription
 * @param id - Subscription ID
 * @returns Promise with renewed subscription
 */
export async function renewSubscription(id: string): Promise<Subscription> {
  const response = await apiClient.post<ApiResponse<Subscription>>(`/api/subscriptions/${id}/renew`);
  return response.data.data;
}

/**
 * Cancel subscription
 * @param id - Subscription ID
 * @returns Promise with cancelled subscription
 */
export async function cancelSubscription(id: string): Promise<Subscription> {
  const response = await apiClient.post<ApiResponse<Subscription>>(`/api/subscriptions/${id}/cancel`);
  return response.data.data;
}

/**
 * Get expiring subscriptions
 * @param days - Number of days until expiration (default: 7)
 * @returns Promise with array of expiring subscriptions
 */
export async function getExpiringSubscriptions(days: number = 7): Promise<Subscription[]> {
  const response = await apiClient.get<ApiResponse<Subscription[]>>('/api/subscriptions/expiring', {
    params: { days },
  });
  return response.data.data;
}

/**
 * Subscriptions service object
 */
export const subscriptionsService = {
  getSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  renewSubscription,
  cancelSubscription,
  getExpiringSubscriptions,
};
