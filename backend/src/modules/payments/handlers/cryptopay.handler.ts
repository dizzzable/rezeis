import { PaymentWebhookHandler } from '../webhook.base.js';
import { logger } from '../../../utils/logger.js';
import type { WebhookPayload } from '../types.js';

/**
 * Cryptopay webhook payload interface
 */
interface CryptopayWebhookPayload {
  update_id: number;
  update_type: string;
  request_date: string;
  payload: {
    invoice_id: string;
    status: string;
    pay_currency?: string;
    pay_amount?: string;
    network?: string;
    address?: string;
    paid_amount?: string;
    paid_at?: string;
    created_at: string;
    expired_at?: string;
    description?: string;
    metadata?: string;
    custom_id?: string;
    payload?: string;
  };
}

/**
 * Cryptopay webhook handler
 * Handles webhooks from Cryptopay payment gateway
 */
export class CryptopayWebhookHandler extends PaymentWebhookHandler {
  readonly gatewayName = 'cryptopay';

  /**
   * Validate webhook signature using HMAC-SHA256
   * Cryptopay uses PBKDF2 with HMAC-SHA256
   * @param payload - Raw request body
   * @param signature - Signature from X-Cryptopay-Signature header
   * @param secret - Webhook secret
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
      logger.error({ error, gateway: this.gatewayName }, 'Failed to validate Cryptopay signature');
      return false;
    }
  }

  /**
   * Parse Cryptopay webhook payload into standardized format
   * @param body - Raw request body
   * @returns Standardized webhook payload
   */
  parsePayload(body: unknown): WebhookPayload {
    try {
      const data = body as CryptopayWebhookPayload;
      const payload = data.payload;

      // Map Cryptopay status to our status
      let status: 'success' | 'failed' | 'pending' = 'pending';
      switch (payload.status) {
        case 'paid':
        case 'completed':
          status = 'success';
          break;
        case 'cancelled':
        case 'expired':
        case 'failed':
          status = 'failed';
          break;
        case 'pending':
        default:
          status = 'pending';
      }

      // Parse metadata
      let metadata: Record<string, unknown> = {};
      try {
        if (payload.metadata) {
          metadata = JSON.parse(payload.metadata);
        }
      } catch {
        metadata = { raw: payload.metadata };
      }

      return {
        gateway: this.gatewayName,
        paymentId: payload.custom_id || payload.invoice_id,
        externalId: payload.invoice_id,
        status,
        amount: parseFloat(payload.paid_amount || '0'),
        currency: payload.pay_currency || 'BTC',
        metadata: {
          ...metadata,
          network: payload.network,
          address: payload.address,
          description: payload.description,
          payload: payload.payload,
        },
        timestamp: payload.paid_at ? new Date(payload.paid_at) : new Date(),
      };
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to parse Cryptopay payload');
      throw new Error('Invalid Cryptopay webhook payload');
    }
  }
}
