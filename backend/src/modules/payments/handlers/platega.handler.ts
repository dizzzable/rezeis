import { PaymentWebhookHandler } from '../webhook.base.js';
import { logger } from '../../../utils/logger.js';
import type { WebhookPayload } from '../types.js';

/**
 * Platega webhook payload interface
 */
interface PlategaWebhookPayload {
  transaction_id: string;
  order_id: string;
  status: 'success' | 'failed' | 'pending' | 'cancelled' | 'completed';
  amount: number;
  currency: string;
  paid_amount?: number;
  paid_currency?: string;
  payment_system?: string;
  payment_id?: string;
  payer_email?: string;
  payer_phone?: string;
  description?: string;
  created_at: string;
  paid_at?: string;
  metadata?: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
}

/**
 * Platega webhook handler
 * Handles webhooks from Platega payment gateway
 */
export class PlategaWebhookHandler extends PaymentWebhookHandler {
  readonly gatewayName = 'platega';

  /**
   * Validate webhook signature using HMAC-SHA256
   * Platega uses signature based on transaction data
   * @param payload - Raw request body or parsed payload
   * @param signature - Signature from headers
   * @param secret - Secret key
   * @returns True if signature is valid
   */
  validateSignature(payload: unknown, signature: string, secret: string): boolean {
    try {
      let dataToSign: string;

      if (typeof payload === 'string') {
        dataToSign = payload;
      } else {
        const data = payload as PlategaWebhookPayload;
        dataToSign = JSON.stringify({
          transaction_id: data.transaction_id,
          order_id: data.order_id,
          status: data.status,
          amount: data.amount,
          currency: data.currency,
        });
      }

      return this.validateHmacSignature(dataToSign, signature, secret);
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to validate Platega signature');
      return false;
    }
  }

  /**
   * Parse Platega webhook payload into standardized format
   * @param body - Raw request body
   * @returns Standardized webhook payload
   */
  parsePayload(body: unknown): WebhookPayload {
    try {
      const data = body as PlategaWebhookPayload;

      // Map Platega status to our status
      let status: 'success' | 'failed' | 'pending' = 'pending';
      switch (data.status) {
        case 'success':
        case 'completed':
          status = 'success';
          break;
        case 'failed':
        case 'cancelled':
          status = 'failed';
          break;
        case 'pending':
        default:
          status = 'pending';
      }

      return {
        gateway: this.gatewayName,
        paymentId: data.order_id,
        externalId: data.transaction_id,
        status,
        amount: data.paid_amount || data.amount,
        currency: data.paid_currency || data.currency,
        metadata: {
          ...data.metadata,
          paymentSystem: data.payment_system,
          paymentId: data.payment_id,
          description: data.description,
          originalAmount: data.amount,
          originalCurrency: data.currency,
        },
        customerEmail: data.payer_email,
        errorMessage: data.error_message,
        timestamp: data.paid_at ? new Date(data.paid_at) : new Date(),
      };
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to parse Platega payload');
      throw new Error('Invalid Platega webhook payload');
    }
  }
}
