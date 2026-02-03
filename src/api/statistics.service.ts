import apiClient from './client';
import type {
  DashboardStats,
  RevenueStats,
  UserStats,
  SubscriptionStats,
  DailyStatistics,
  ApiResponse,
} from '../types/entity.types';

/**
 * Statistics API service
 * Handles all API calls related to statistics and analytics
 */

/**
 * Get dashboard statistics
 * @returns Promise with dashboard stats
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const response = await apiClient.get<ApiResponse<DashboardStats>>('/api/statistics/dashboard');
  return response.data.data;
}

/**
 * Get revenue statistics
 * @param startDate - Start date for the period
 * @param endDate - End date for the period
 * @returns Promise with revenue stats
 */
export async function getRevenueStats(startDate?: Date, endDate?: Date): Promise<RevenueStats> {
  const params: Record<string, string> = {};
  if (startDate) params.startDate = startDate.toISOString();
  if (endDate) params.endDate = endDate.toISOString();

  const response = await apiClient.get<ApiResponse<RevenueStats>>('/api/statistics/revenue', {
    params,
  });
  return response.data.data;
}

/**
 * Get user statistics
 * @returns Promise with user stats
 */
export async function getUserStats(): Promise<UserStats> {
  const response = await apiClient.get<ApiResponse<UserStats>>('/api/statistics/users');
  return response.data.data;
}

/**
 * Get subscription statistics
 * @returns Promise with subscription stats
 */
export async function getSubscriptionStats(): Promise<SubscriptionStats> {
  const response = await apiClient.get<ApiResponse<SubscriptionStats>>('/api/statistics/subscriptions');
  return response.data.data;
}

/**
 * Get daily statistics for a date range
 * @param startDate - Start date for the period
 * @param endDate - End date for the period
 * @returns Promise with array of daily statistics
 */
export async function getDailyStatistics(startDate?: Date, endDate?: Date): Promise<DailyStatistics[]> {
  const params: Record<string, string> = {};
  if (startDate) params.startDate = startDate.toISOString();
  if (endDate) params.endDate = endDate.toISOString();

  const response = await apiClient.get<ApiResponse<DailyStatistics[]>>('/api/statistics/daily', {
    params,
  });
  return response.data.data;
}

/**
 * Statistics service object
 */
export const statisticsService = {
  getDashboardStats,
  getRevenueStats,
  getUserStats,
  getSubscriptionStats,
  getDailyStatistics,
};
