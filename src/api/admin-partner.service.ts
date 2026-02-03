import apiClient from './client';
import type { PaginatedResult } from '../types/entity.types';

/**
 * Admin Partner Service
 * Handles admin operations for the hidden partner program
 */

// ============================================================================
// Types
// ============================================================================

export interface Partner {
  id: string;
  userId: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  isPartner: boolean;
  partnerActivatedAt: string | null;
  partnerActivatedBy: string | null;
  partnerNotes: string | null;
  balance: number;
  totalEarnings: number;
  referralCount: number;
  createdAt: string;
}

export interface PartnerSettings {
  id: string;
  isEnabled: boolean;
  level1Percent: number;
  level2Percent: number;
  level3Percent: number;
  taxPercent: number;
  minPayoutAmount: number;
  paymentSystemFee: number;
  createdAt: string;
  updatedAt: string;
}

export interface PartnerStats {
  userId: string;
  totalEarnings: number;
  pendingEarnings: number;
  paidEarnings: number;
  referralCount: number;
  activeReferrals: number;
  conversionRate: number;
  totalClicks: number;
  totalConversions: number;
}

export interface PayoutRequest {
  id: string;
  partnerId: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected' | 'completed';
  paymentMethod: string;
  paymentDetails: Record<string, unknown>;
  notes: string | null;
  processedBy: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface ActivatePartnerDTO {
  notes?: string;
}

export interface DeactivatePartnerDTO {
  reason?: string;
}

export interface ProcessPayoutDTO {
  status: 'approved' | 'rejected' | 'completed';
  notes?: string;
}

export interface UpdateSettingsDTO {
  isEnabled?: boolean;
  level1Percent?: number;
  level2Percent?: number;
  level3Percent?: number;
  taxPercent?: number;
  minPayoutAmount?: number;
  paymentSystemFee?: number;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get all partners with pagination and search
 */
export async function getPartners(params: {
  page?: number;
  limit?: number;
  search?: string;
}): Promise<PaginatedResult<Partner>> {
  const response = await apiClient.get('/api/admin/partners', { params });
  const { items, total, page, limit } = response.data.data;
  return {
    data: items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Activate partner for user
 */
export async function activatePartner(
  userId: string,
  data: ActivatePartnerDTO
): Promise<Partner> {
  const response = await apiClient.post(`/api/admin/partners/${userId}/activate`, data);
  return response.data.data;
}

/**
 * Deactivate partner for user
 */
export async function deactivatePartner(
  userId: string,
  data: DeactivatePartnerDTO
): Promise<Partner> {
  const response = await apiClient.post(`/api/admin/partners/${userId}/deactivate`, data);
  return response.data.data;
}

/**
 * Get partner statistics
 */
export async function getPartnerStats(userId: string): Promise<PartnerStats> {
  const response = await apiClient.get(`/api/admin/partners/${userId}/stats`);
  return response.data.data;
}

/**
 * Get partner settings
 */
export async function getPartnerSettings(): Promise<PartnerSettings> {
  const response = await apiClient.get('/api/admin/partner-settings');
  return response.data.data;
}

/**
 * Update partner settings
 */
export async function updatePartnerSettings(data: UpdateSettingsDTO): Promise<PartnerSettings> {
  const response = await apiClient.put('/api/admin/partner-settings', data);
  return response.data.data;
}

/**
 * Get all payout requests
 */
export async function getPayouts(params: {
  status?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedResult<PayoutRequest>> {
  const response = await apiClient.get('/api/admin/partner-payouts', { params });
  const { items, total, page, limit } = response.data.data;
  return {
    data: items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Process a payout request
 */
export async function processPayout(
  payoutId: string,
  data: ProcessPayoutDTO
): Promise<PayoutRequest> {
  const response = await apiClient.post(`/api/admin/partner-payouts/${payoutId}/process`, data);
  return response.data.data;
}

// ============================================================================
// Service Export
// ============================================================================

export const adminPartnerService = {
  getPartners,
  activatePartner,
  deactivatePartner,
  getPartnerStats,
  getPartnerSettings,
  updatePartnerSettings,
  getPayouts,
  processPayout,
};

export default adminPartnerService;
