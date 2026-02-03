import { PaymentWebhookHandler } from '../webhook.base.js';
import { logger } from '../../../utils/logger.js';
import type { WebhookPayload } from '../types.js';

/**
 * Wata webhook payload interface
 */
interface WataWebhookPayload {
  id: string;
  order_id: string;
  status: 'success' | 'failed' | 'pending' | 'cancelled' | 'completed' | 'refunded';
  amount: number;
  currency: string;
  payment_amount?: number;
  payment_currency?: string;
  payment_method?: string;
  payment_system?: string;
  customer_email?: string;
  customer_phone?: string;
  description?: string;
  created_at: string;
  processed_at?: string;
  metadata?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Wata webhook handler
 * Handles webhooks from Wata payment gateway
 */
export class WataWebhookHandler extends PaymentWebhookHandler {
  readonly gatewayName = 'wata';

  /**
   * Validate webhook signature using HMAC-SHA256
   * Wata uses signature based on request body
   * @param payload - Raw request body
   * @param signature - Signature from X-Wata-Signature header
   * @param secret - Secret key
   * @returns True if signature is valid
   */
  validateSignature(payload: unknown, signature: string, secret: string): boolean {
    try {
      if (typeof payload !== 'string') {
        logger.warn({ gateway: this.gatewayName }, 'Payload must be a string for signature validation');
        return false;
      }

      return this.validateHmacSignature(payload, signature, secret);
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to validate Wata signature');
      return false;
    }
  }

  /**
   * Parse Wata webhook payload into standardized format
   * @param body - Raw request body
   * @returns Standardized webhook payload
   */
  parsePayload(body: unknown): WebhookPayload {
    try {
      const data = body as WataWebhookPayload;

      // Map Wata status to our status
      let status: 'success' | 'failed' | 'pending' | 'refunded' = 'pending';
      switch (data.status) {
        case 'success':
        case 'completed':
          status = 'success';
          break;
        case 'failed':
        case 'cancelled':
          status = 'failed';
          break;
        case 'refunded':
          status = 'refunded';
          break;
        case 'pending':
        default:
          status = 'pending';
      }

      return {
        gateway: this.gatewayName,
        paymentId: data.order_id,
        externalId: data.id,
        status,
        amount: data.payment_amount || data.amount,
        currency: data.payment_currency || data.currency,
        metadata: {
          ...data.metadata,
          paymentMethod: data.payment_method,
          paymentSystem: data.payment_system,
          description: data.description,
          originalAmount: data.amount,
          originalCurrency: data.currency,
        },
        customerEmail: data.customer_email,
        errorMessage: data.error?.message,
        timestamp: data.processed_at ? new Date(data.processed_at) : new Date(),
      };
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to parse Wata payload');
      throw new Error('Invalid Wata webhook payload');
    }
  }
}
