import { PaymentWebhookHandler } from '../webhook.base.js';
import { logger } from '../../../utils/logger.js';
import type { WebhookPayload } from '../types.js';

/**
 * YooKassa webhook payload interface
 */
interface YooKassaWebhookPayload {
  type: string;
  event: string;
  object: {
    id: string;
    status: string;
    paid: boolean;
    amount: {
      value: string;
      currency: string;
    };
    income_amount?: {
      value: string;
      currency: string;
    };
    description?: string;
    created_at: string;
    captured_at?: string;
    expires_at?: string;
    metadata?: Record<string, string>;
    payment_method?: {
      type: string;
      id: string;
      saved: boolean;
      title?: string;
    };
    recipient?: {
      account_id: string;
      gateway_id: string;
    };
    refundable?: boolean;
    refundable_amount?: {
      value: string;
      currency: string;
    };
    test?: boolean;
  };
}

/**
 * YooKassa webhook handler
 * Handles webhooks from YooKassa payment gateway (formerly Yandex.Kassa)
 */
export class YooKassaWebhookHandler extends PaymentWebhookHandler {
  readonly gatewayName = 'yookassa';

  /**
   * Validate webhook signature using HMAC-SHA256
   * YooKassa uses IP whitelist + signature validation
   * @param payload - Raw request body
   * @param signature - Signature from headers
   * @param secret - Shop secret key
   * @returns True if signature is valid
   */
  validateSignature(payload: unknown, signature: string, secret: string): boolean {
    try {
      if (typeof payload !== 'string') {
        logger.warn({ gateway: this.gatewayName }, 'Payload must be a string for signature validation');
        return false;
      }

      // YooKassa signature is in format: <shop_id>|<body_hash>
      this.computeSha256(payload);
      const expectedSignature = signature;

      // YooKassa validation: compare provided signature with our computed hash
      // In production, you should also verify the IP is from YooKassa's whitelist
      return this.validateHmacSignature(payload, expectedSignature, secret);
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to validate YooKassa signature');
      return false;
    }
  }

  /**
   * Parse YooKassa webhook payload into standardized format
   * @param body - Raw request body
   * @returns Standardized webhook payload
   */
  parsePayload(body: unknown): WebhookPayload {
    try {
      const data = body as YooKassaWebhookPayload;
      const obj = data.object;

      // Map YooKassa status to our status
      let status: 'success' | 'failed' | 'pending' = 'pending';
      switch (obj.status) {
        case 'succeeded':
        case 'canceled':
          if (obj.paid) {
            status = 'success';
          } else {
            status = 'failed';
          }
          break;
        case 'pending':
        case 'waiting_for_capture':
        default:
          status = 'pending';
      }

      // Extract payment ID from metadata or use YooKassa payment ID
      const paymentId = obj.metadata?.payment_id || obj.metadata?.transaction_id || obj.id;

      return {
        gateway: this.gatewayName,
        paymentId: String(paymentId),
        externalId: obj.id,
        status,
        amount: parseFloat(obj.amount.value),
        currency: obj.amount.currency,
        metadata: {
          ...obj.metadata,
          description: obj.description,
          paymentMethod: obj.payment_method?.type,
          paymentMethodTitle: obj.payment_method?.title,
          capturedAt: obj.captured_at,
          isTest: obj.test,
          isRefundable: obj.refundable,
        },
        timestamp: obj.captured_at ? new Date(obj.captured_at) : new Date(),
      };
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to parse YooKassa payload');
      throw new Error('Invalid YooKassa webhook payload');
    }
  }
}
