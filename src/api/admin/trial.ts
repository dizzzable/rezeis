import apiClient from '../client';

/**
 * Trial Admin API service
 * Handles all API calls related to trial management for administrators
 */

export interface TrialSettings {
  isEnabled: boolean;
  durationDays: number;
  trafficLimitGb: number;
  deviceTypes: string[];
  maxUsesPerUser: number;
  requirePhone: boolean;
}

export interface TrialStats {
  totalTrials: number;
  activeTrials: number;
  convertedToPaid: number;
  conversionRate: number;
}

export interface TrialUser {
  userId: string;
  username?: string;
  trialStartDate: string;
  trialEndDate: string;
  trafficUsedGb: number;
  isActive: boolean;
  wasConverted: boolean;
}

export interface TrialHistoryEntry {
  id: string;
  userId: string;
  grantedAt: string;
  expiresAt: string;
  usedDays: number;
  wasConverted: boolean;
  convertedAt?: string;
}

export interface GrantTrialInput {
  userId: string;
  durationDays?: number;
}

/**
 * Get trial settings
 */
export async function getTrialSettings(): Promise<TrialSettings> {
  const response = await apiClient.get<TrialSettings>('/admin/trial/settings');
  return response.data;
}

/**
 * Update trial settings
 */
export async function updateTrialSettings(settings: TrialSettings): Promise<void> {
  await apiClient.put('/admin/trial/settings', settings);
}

/**
 * Get trial statistics
 */
export async function getTrialStats(): Promise<TrialStats> {
  const response = await apiClient.get<TrialStats>('/admin/trial/stats');
  return response.data;
}

/**
 * Reset trial for a user
 */
export async function resetUserTrial(userId: string): Promise<void> {
  await apiClient.post('/admin/trial/reset-user', { userId });
}

/**
 * Grant trial to a user manually
 */
export async function grantTrial(input: GrantTrialInput): Promise<void> {
  await apiClient.post('/admin/trial/grant', input);
}

/**
 * Get trial history for a user
 */
export async function getTrialHistory(userId: string): Promise<TrialHistoryEntry[]> {
  const response = await apiClient.get<TrialHistoryEntry[]>(`/admin/trial/history/${userId}`);
  return response.data;
}

/**
 * Get all users with active trials
 */
export async function getActiveTrialUsers(): Promise<TrialUser[]> {
  const response = await apiClient.get<TrialUser[]>('/admin/trial/active-users');
  return response.data;
}

/**
 * Revoke trial from a user
 */
export async function revokeTrial(userId: string): Promise<void> {
  await apiClient.post('/admin/trial/revoke', { userId });
}

/**
 * Trial Admin API object
 */
export const trialAdminApi = {
  getSettings: getTrialSettings,
  updateSettings: updateTrialSettings,
  getStats: getTrialStats,
  resetUser: resetUserTrial,
  grant: grantTrial,
  getHistory: getTrialHistory,
  getActiveUsers: getActiveTrialUsers,
  revoke: revokeTrial,
};
