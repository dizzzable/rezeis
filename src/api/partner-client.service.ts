import apiClient from './client';
import type { PaginatedResult } from '../types/entity.types';

/**
 * Client Partner Service
 * Handles client-side partner program operations
 */

// ============================================================================
// Types
// ============================================================================

export interface PartnerStatus {
  isPartner: boolean;
  canRequest: boolean;
  activatedAt: string | null;
  notes: string | null;
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

export interface PartnerSettings {
  isEnabled: boolean;
  level1Percent: number;
  level2Percent: number;
  level3Percent: number;
  minPayoutAmount: number;
}

export interface Referral {
  id: string;
  referredId: string;
  status: string;
  points: number;
  createdAt: string;
  referredUsername?: string;
  referredFirstName?: string;
  referredPhotoUrl?: string;
}

export interface Earning {
  id: string;
  amount: number;
  commissionPercent: number;
  level: number;
  status: string;
  createdAt: string;
  paidAt: string | null;
  fromUsername?: string;
  fromFirstName?: string;
}

export interface Payout {
  id: string;
  amount: number;
  status: string;
  paymentMethod: string;
  notes: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface CreatePayoutDTO {
  amount: number;
  paymentMethod: string;
  paymentDetails: Record<string, unknown>;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get partner status for current user
 */
export async function getPartnerStatus(): Promise<PartnerStatus> {
  const response = await apiClient.get('/api/client/partner/status');
  return response.data.data;
}

/**
 * Get partner statistics
 */
export async function getPartnerStats(): Promise<PartnerStats> {
  const response = await apiClient.get('/api/client/partner/stats');
  return response.data.data;
}

/**
 * Get partner referrals
 */
export async function getPartnerReferrals(params: {
  page?: number;
  limit?: number;
}): Promise<PaginatedResult<Referral>> {
  const response = await apiClient.get('/api/client/partner/referrals', { params });
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
 * Get partner earnings history
 */
export async function getPartnerEarnings(params: {
  page?: number;
  limit?: number;
}): Promise<PaginatedResult<Earning>> {
  const response = await apiClient.get('/api/client/partner/earnings', { params });
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
 * Get partner payouts history
 */
export async function getPartnerPayouts(params: {
  page?: number;
  limit?: number;
}): Promise<PaginatedResult<Payout>> {
  const response = await apiClient.get('/api/client/partner/payouts', { params });
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
 * Create payout request
 */
export async function createPayoutRequest(data: CreatePayoutDTO): Promise<Payout> {
  const response = await apiClient.post('/api/client/partner/payouts', data);
  return response.data.data;
}

/**
 * Get partner program settings
 */
export async function getPartnerSettings(): Promise<PartnerSettings> {
  const response = await apiClient.get('/api/client/partner/settings');
  return response.data.data;
}

// ============================================================================
// Service Export
// ============================================================================

export const partnerClientService = {
  getPartnerStatus,
  getPartnerStats,
  getPartnerReferrals,
  getPartnerEarnings,
  getPartnerPayouts,
  createPayoutRequest,
  getPartnerSettings,
};

export default partnerClientService;
