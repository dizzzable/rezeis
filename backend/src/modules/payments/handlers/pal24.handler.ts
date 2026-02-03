import { PaymentWebhookHandler } from '../webhook.base.js';
import { logger } from '../../../utils/logger.js';
import type { WebhookPayload } from '../types.js';

/**
 * Pal24 webhook payload interface
 */
interface Pal24WebhookPayload {
  payment_id: string;
  order_id: string;
  status: 'success' | 'failed' | 'pending' | 'cancelled' | 'completed';
  amount: number;
  currency: string;
  pay_amount?: number;
  pay_currency?: string;
  payer_email?: string;
  payer_phone?: string;
  payment_method?: string;
  transaction_id?: string;
  created_at: string;
  completed_at?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

/**
 * Pal24 webhook handler
 * Handles webhooks from Pal24 payment gateway
 */
export class Pal24WebhookHandler extends PaymentWebhookHandler {
  readonly gatewayName = 'pal24';

  /**
   * Validate webhook signature using MD5 or HMAC-SHA256
   * Pal24 uses signature based on payment data
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
        // If payload is object, create signature string
        const data = payload as Pal24WebhookPayload;
        dataToSign = `${data.payment_id}:${data.order_id}:${data.status}:${data.amount}:${data.currency}:${secret}`;
      }

      const computedSignature = this.computeMd5(dataToSign);
      return computedSignature === signature.toLowerCase();
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to validate Pal24 signature');
      return false;
    }
  }

  /**
   * Parse Pal24 webhook payload into standardized format
   * @param body - Raw request body
   * @returns Standardized webhook payload
   */
  parsePayload(body: unknown): WebhookPayload {
    try {
      const data = body as Pal24WebhookPayload;

      // Map Pal24 status to our status
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
        externalId: data.payment_id,
        status,
        amount: data.pay_amount || data.amount,
        currency: data.pay_currency || data.currency,
        metadata: {
          ...data.metadata,
          transactionId: data.transaction_id,
          paymentMethod: data.payment_method,
          originalAmount: data.amount,
          originalCurrency: data.currency,
        },
        customerEmail: data.payer_email,
        errorMessage: data.error,
        timestamp: data.completed_at ? new Date(data.completed_at) : new Date(),
      };
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to parse Pal24 payload');
      throw new Error('Invalid Pal24 webhook payload');
    }
  }
}
