/**
 * Payment webhook types and interfaces
 */

/**
 * Payment status enum
 */
export type PaymentStatus = 'success' | 'failed' | 'pending' | 'refunded';

/**
 * Payment type enum
 */
export type PaymentType = 'subscription' | 'balance' | 'other';

/**
 * Webhook payload interface
 * Standardized format for all payment gateways
 */
export interface WebhookPayload {
  /** Gateway identifier */
  gateway: string;
  /** Internal payment/transaction ID */
  paymentId: string;
  /** External payment ID from gateway */
  externalId: string;
  /** Payment status */
  status: PaymentStatus;
  /** Payment amount */
  amount: number;
  /** Currency code (e.g., USD, RUB, EUR) */
  currency: string;
  /** Additional metadata */
  metadata: Record<string, unknown>;
  /** Signature for verification */
  signature?: string;
  /** Payment timestamp */
  timestamp?: Date;
  /** Customer email or identifier */
  customerEmail?: string;
  /** Error message for failed payments */
  errorMessage?: string;
}

/**
 * Webhook result interface
 */
export interface WebhookResult {
  /** Whether the webhook was processed successfully */
  success: boolean;
  /** Response message */
  message: string;
  /** Internal payment ID */
  paymentId?: string;
  /** HTTP status code to return */
  statusCode?: number;
}

/**
 * Webhook handler config
 */
export interface WebhookHandlerConfig {
  /** Gateway name */
  gatewayName: string;
  /** Webhook secret for signature validation */
  webhookSecret: string;
  /** Allowed IP addresses (optional) */
  allowedIps?: string[];
  /** Additional configuration */
  additionalConfig?: Record<string, unknown>;
}

/**
 * Payment transaction entity
 */
export interface PaymentTransaction {
  id: string;
  userId: string;
  gatewayId: string;
  externalId: string | null;
  amount: number;
  currency: string;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  type: PaymentType;
  metadata: Record<string, unknown>;
  errorMessage: string | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Create payment transaction DTO
 */
export interface CreatePaymentTransactionDTO {
  userId: string;
  gatewayId: string;
  externalId?: string;
  amount: number;
  currency: string;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  type: PaymentType;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
  paidAt?: Date;
}

/**
 * Update payment transaction DTO
 */
export interface UpdatePaymentTransactionDTO {
  externalId?: string;
  status?: 'pending' | 'completed' | 'failed' | 'refunded';
  metadata?: Record<string, unknown>;
  errorMessage?: string;
  paidAt?: Date;
}

/**
 * Payment gateway configuration
 */
export interface PaymentGatewayConfig {
  id: string;
  name: string;
  displayName: string;
  isEnabled: boolean;
  sortOrder: number;
  config: Record<string, unknown>;
  webhookSecret: string | null;
  allowedIps: string[] | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Webhook log entry
 */
export interface WebhookLogEntry {
  id: string;
  gateway: string;
  payload: Record<string, unknown>;
  signature: string | null;
  isValid: boolean;
  processingResult: WebhookResult;
  createdAt: Date;
}

/**
 * Idempotency key entry
 */
export interface IdempotencyKey {
  key: string;
  gateway: string;
  paymentId: string;
  processedAt: Date;
  expiresAt: Date;
}

/**
 * Referral points input
 */
export interface ReferralPointsInput {
  referrerId: string;
  referredId: string;
  amount: number;
  source: string;
}

/**
 * Partner commission input
 */
export interface PartnerCommissionInput {
  partnerId: string;
  userId: string;
  amount: number;
  orderId: string;
}

/**
 * Payment notification data
 */
export interface PaymentNotificationData {
  amount: number;
  currency: string;
  type: PaymentType;
  status: PaymentStatus;
  planName?: string;
  errorMessage?: string;
}
