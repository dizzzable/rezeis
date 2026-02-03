import apiClient from './client';
import type {
  Gateway,
  CreateGatewayDTO,
  UpdateGatewayDTO,
  GetGatewaysParams,
  ApiResponse,
} from '@/types/entity.types';

/**
 * Payment Gateway Summary from admin API
 */
export interface PaymentGatewaySummary {
  id: string;
  name: string;
  displayName: string;
  isEnabled: boolean;
  sortOrder: number;
  status: 'active' | 'inactive' | 'testing';
  icon?: string;
  supportedCurrencies: string[];
  webhookUrl: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Payment Gateway Detail from admin API
 */
export interface PaymentGatewayDetail {
  id: string;
  name: string;
  displayName: string;
  isEnabled: boolean;
  sortOrder: number;
  config: Record<string, unknown>;
  webhookSecret?: string;
  allowedIps?: string[];
  status: 'active' | 'inactive' | 'testing';
  description?: string;
  icon?: string;
  supportedCurrencies: string[];
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  feeFixed?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Test connection result
 */
export interface TestConnectionResult {
  success: boolean;
  message: string;
  responseTime?: number;
  details?: Record<string, unknown>;
}

/**
 * Webhook URL response
 */
export interface WebhookUrlResponse {
  gateway: string;
  webhookUrl: string;
  verificationUrl: string;
}

/**
 * Gateways API service
 * Handles all API calls related to payment gateway management
 */

/**
 * Get all gateways (legacy API)
 * @param params - Filter params
 * @returns Promise with array of gateways
 */
export async function getAll(params?: GetGatewaysParams): Promise<Gateway[]> {
  const response = await apiClient.get<ApiResponse<Gateway[]>>('/api/gateways', {
    params,
  });
  return response.data.data;
}

/**
 * Get active gateways (legacy API)
 * @returns Promise with array of active gateways
 */
export async function getActive(): Promise<Gateway[]> {
  const response = await apiClient.get<ApiResponse<Gateway[]>>('/api/gateways/active');
  return response.data.data;
}

/**
 * Get default gateway (legacy API)
 * @returns Promise with default gateway
 */
export async function getDefault(): Promise<Gateway> {
  const response = await apiClient.get<ApiResponse<Gateway>>('/api/gateways/default');
  return response.data.data;
}

/**
 * Get gateway by ID (legacy API)
 * @param id - Gateway ID
 * @returns Promise with gateway data
 */
export async function getById(id: string): Promise<Gateway> {
  const response = await apiClient.get<ApiResponse<Gateway>>(`/api/gateways/${id}`);
  return response.data.data;
}

/**
 * Create new gateway (legacy API)
 * @param data - Gateway creation data
 * @returns Promise with created gateway
 */
export async function create(data: CreateGatewayDTO): Promise<Gateway> {
  const response = await apiClient.post<ApiResponse<Gateway>>('/api/gateways', data);
  return response.data.data;
}

/**
 * Update gateway (legacy API)
 * @param id - Gateway ID
 * @param data - Gateway update data
 * @returns Promise with updated gateway
 */
export async function update(id: string, data: UpdateGatewayDTO): Promise<Gateway> {
  const response = await apiClient.put<ApiResponse<Gateway>>(`/api/gateways/${id}`, data);
  return response.data.data;
}

/**
 * Delete gateway (legacy API)
 * @param id - Gateway ID
 * @returns Promise that resolves when gateway is deleted
 */
export async function deleteGateway(id: string): Promise<void> {
  await apiClient.delete<ApiResponse<void>>(`/api/gateways/${id}`);
}

/**
 * Toggle gateway active status (legacy API)
 * @param id - Gateway ID
 * @returns Promise with updated gateway
 */
export async function toggleActive(id: string): Promise<Gateway> {
  const response = await apiClient.post<ApiResponse<Gateway>>(`/api/gateways/${id}/toggle`);
  return response.data.data;
}

/**
 * Set gateway as default (legacy API)
 * @param id - Gateway ID
 * @returns Promise with updated gateway
 */
export async function setDefault(id: string): Promise<Gateway> {
  const response = await apiClient.post<ApiResponse<Gateway>>(`/api/gateways/${id}/default`);
  return response.data.data;
}

// =============================================================================
// NEW ADMIN PAYMENT GATEWAY API
// =============================================================================

/**
 * Get all payment gateways from admin API
 * @returns Promise with array of gateway summaries
 */
export async function getAllAdmin(): Promise<PaymentGatewaySummary[]> {
  const response = await apiClient.get<ApiResponse<PaymentGatewaySummary[]>>('/api/admin/payment-gateways');
  return response.data.data;
}

/**
 * Get payment gateway by ID from admin API
 * @param id - Gateway ID
 * @returns Promise with gateway detail
 */
export async function getByIdAdmin(id: string): Promise<PaymentGatewayDetail> {
  const response = await apiClient.get<ApiResponse<PaymentGatewayDetail>>(`/api/admin/payment-gateways/${id}`);
  return response.data.data;
}

/**
 * Create new payment gateway via admin API
 * @param data - Gateway creation data
 * @returns Promise with created gateway
 */
export async function createAdmin(data: {
  name: string;
  displayName: string;
  config: Record<string, unknown>;
  isEnabled?: boolean;
  sortOrder?: number;
  allowedIps?: string[];
  description?: string;
  supportedCurrencies?: string[];
  minAmount?: number;
  maxAmount?: number;
  feePercent?: number;
  feeFixed?: number;
}): Promise<PaymentGatewayDetail> {
  const response = await apiClient.post<ApiResponse<PaymentGatewayDetail>>('/api/admin/payment-gateways', data);
  return response.data.data;
}

/**
 * Update payment gateway via admin API
 * @param id - Gateway ID
 * @param data - Gateway update data
 * @returns Promise with updated gateway
 */
export async function updateAdmin(
  id: string,
  data: {
    displayName?: string;
    config?: Record<string, unknown>;
    isEnabled?: boolean;
    sortOrder?: number;
    allowedIps?: string[];
    description?: string;
    supportedCurrencies?: string[];
    minAmount?: number;
    maxAmount?: number;
    feePercent?: number;
    feeFixed?: number;
  }
): Promise<PaymentGatewayDetail> {
  const response = await apiClient.put<ApiResponse<PaymentGatewayDetail>>(`/api/admin/payment-gateways/${id}`, data);
  return response.data.data;
}

/**
 * Delete payment gateway via admin API
 * @param id - Gateway ID
 * @returns Promise that resolves when gateway is deleted
 */
export async function deleteAdmin(id: string): Promise<void> {
  await apiClient.delete<ApiResponse<void>>(`/api/admin/payment-gateways/${id}`);
}

/**
 * Toggle gateway enabled status via admin API
 * @param id - Gateway ID
 * @returns Promise with updated gateway
 */
export async function toggleAdmin(id: string): Promise<{ id: string; isEnabled: boolean; status: string }> {
  const response = await apiClient.post<ApiResponse<{ id: string; isEnabled: boolean; status: string }>>(
    `/api/admin/payment-gateways/${id}/toggle`
  );
  return response.data.data;
}

/**
 * Test gateway connection via admin API
 * @param id - Gateway ID
 * @returns Promise with test result
 */
export async function testConnection(id: string): Promise<TestConnectionResult> {
  const response = await apiClient.post<ApiResponse<TestConnectionResult>>(`/api/admin/payment-gateways/${id}/test`);
  return response.data.data;
}

/**
 * Get webhook URL for gateway via admin API
 * @param id - Gateway ID
 * @returns Promise with webhook URL info
 */
export async function getWebhookUrl(id: string): Promise<WebhookUrlResponse> {
  const response = await apiClient.get<ApiResponse<WebhookUrlResponse>>(`/api/admin/payment-gateways/${id}/webhook-url`);
  return response.data.data;
}

/**
 * Initialize default gateways via admin API
 * @returns Promise with initialization result
 */
export async function initializeDefaults(): Promise<{ success: boolean; message?: string }> {
  const response = await apiClient.post<ApiResponse<{ success: boolean; message?: string }>>(
    '/api/admin/payment-gateways/initialize'
  );
  return response.data;
}

/**
 * Get active gateways for client
 * @returns Promise with active gateways
 */
export async function getClientActiveGateways(): Promise<{ gateways: PaymentGatewaySummary[] }> {
  const response = await apiClient.get<ApiResponse<{ gateways: PaymentGatewaySummary[] }>>('/api/client/payment-gateways');
  return response.data.data;
}

/**
 * Gateways service object
 */
export const gatewaysService = {
  // Legacy API
  getAll,
  getActive,
  getDefault,
  getById,
  create,
  update,
  delete: deleteGateway,
  toggleActive,
  setDefault,
  // New Admin API
  getAllAdmin,
  getByIdAdmin,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  toggleAdmin,
  testConnection,
  getWebhookUrl,
  initializeDefaults,
  getClientActiveGateways,
};
