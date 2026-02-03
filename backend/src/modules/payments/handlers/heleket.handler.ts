import { PaymentWebhookHandler } from '../webhook.base.js';
import { logger } from '../../../utils/logger.js';
import type { WebhookPayload } from '../types.js';

/**
 * Heleket webhook payload interface
 */
interface HeleketWebhookPayload {
  id: string;
  order_id: string;
  status: string;
  amount: string;
  currency: string;
  pay_amount?: string;
  pay_currency?: string;
  merchant_amount?: string;
  network?: string;
  address?: string;
  from_address?: string;
  tx_hash?: string;
  created_at: string;
  updated_at: string;
  expired_at?: string;
  metadata?: Record<string, unknown>;
  payment_url?: string;
}

/**
 * Heleket webhook handler
 * Handles webhooks from Heleket crypto payment gateway
 */
export class HeleketWebhookHandler extends PaymentWebhookHandler {
  readonly gatewayName = 'heleket';

  /**
   * Validate webhook signature using HMAC-SHA256
   * Heleket uses signature in X-Webhook-Signature header
   * @param payload - Raw request body
   * @param signature - Signature from headers
   * @param secret - API secret key
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
      logger.error({ error, gateway: this.gatewayName }, 'Failed to validate Heleket signature');
      return false;
    }
  }

  /**
   * Parse Heleket webhook payload into standardized format
   * @param body - Raw request body
   * @returns Standardized webhook payload
   */
  parsePayload(body: unknown): WebhookPayload {
    try {
      const data = body as HeleketWebhookPayload;

      // Map Heleket status to our status
      let status: 'success' | 'failed' | 'pending' = 'pending';
      switch (data.status) {
        case 'completed':
        case 'confirmed':
          status = 'success';
          break;
        case 'cancelled':
        case 'expired':
        case 'failed':
          status = 'failed';
          break;
        case 'pending':
        case 'processing':
        default:
          status = 'pending';
      }

      return {
        gateway: this.gatewayName,
        paymentId: data.order_id,
        externalId: data.id,
        status,
        amount: parseFloat(data.pay_amount || data.amount),
        currency: data.pay_currency || data.currency,
        metadata: {
          ...data.metadata,
          network: data.network,
          address: data.address,
          fromAddress: data.from_address,
          transactionHash: data.tx_hash,
          merchantAmount: data.merchant_amount,
          originalAmount: data.amount,
          originalCurrency: data.currency,
          paymentUrl: data.payment_url,
        },
        timestamp: new Date(data.updated_at),
      };
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to parse Heleket payload');
      throw new Error('Invalid Heleket webhook payload');
    }
  }
}
