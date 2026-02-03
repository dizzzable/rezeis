import { PaymentWebhookHandler } from '../webhook.base.js';
import { logger } from '../../../utils/logger.js';
import type { WebhookPayload } from '../types.js';

/**
 * Telegram Stars webhook payload interface
 * Based on Telegram Bot API successful_payment update
 */
interface TelegramStarsWebhookPayload {
  update_id: number;
  pre_checkout_query?: {
    id: string;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    currency: string;
    total_amount: number;
    invoice_payload: string;
  };
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot: boolean;
      first_name: string;
    };
    date: number;
    chat: {
      id: number;
      type: string;
    };
    successful_payment?: {
      currency: string;
      total_amount: number;
      invoice_payload: string;
      telegram_payment_charge_id: string;
      provider_payment_charge_id?: string;
    };
  };
  successful_payment?: {
    currency: string;
    total_amount: number;
    invoice_payload: string;
    telegram_payment_charge_id: string;
    provider_payment_charge_id?: string;
  };
}

/**
 * Telegram Stars webhook handler
 * Handles payments via Telegram Stars (Telegram's native payment system)
 */
export class TelegramStarsWebhookHandler extends PaymentWebhookHandler {
  readonly gatewayName = 'telegram-stars';

  /**
   * Validate webhook using bot token
   * Telegram webhooks are validated by checking the update structure
   * and can be further secured with secret token in webhook setup
   * @param payload - Raw request body
   * @param signature - Secret token from X-Telegram-Bot-Api-Secret-Token header
   * @param secret - Bot token or secret
   * @returns True if valid (Telegram doesn't use traditional signatures)
   */
  validateSignature(_payload: unknown, signature: string, secret: string): boolean {
    try {
      // Telegram webhooks can be validated using a secret token
      // that is set when configuring the webhook URL
      if (signature && secret) {
        return signature === secret;
      }

      // If no signature provided, we still accept but log a warning
      // In production, you should always use a secret token
      logger.warn({ gateway: this.gatewayName }, 'No signature provided for Telegram webhook');
      return true;
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to validate Telegram webhook');
      return false;
    }
  }

  /**
   * Parse Telegram webhook payload into standardized format
   * @param body - Raw request body
   * @returns Standardized webhook payload
   */
  parsePayload(body: unknown): WebhookPayload {
    try {
      const data = body as TelegramStarsWebhookPayload;

      // Get payment info from successful_payment
      const successfulPayment = data.message?.successful_payment || data.successful_payment;
      const preCheckoutQuery = data.pre_checkout_query;

      if (!successfulPayment && !preCheckoutQuery) {
        throw new Error('No payment data found in Telegram webhook');
      }

      // Determine status
      let status: 'success' | 'failed' | 'pending' = 'pending';
      if (successfulPayment) {
        status = 'success';
      } else if (preCheckoutQuery) {
        status = 'pending';
      }

      // Parse invoice payload to extract metadata
      let metadata: Record<string, unknown> = {};
      const payloadStr = successfulPayment?.invoice_payload || preCheckoutQuery?.invoice_payload;
      if (payloadStr) {
        try {
          metadata = JSON.parse(payloadStr);
        } catch {
          metadata = { rawPayload: payloadStr };
        }
      }

      // Get user info
      const userId = data.message?.chat?.id?.toString() ||
                     preCheckoutQuery?.from?.id?.toString() ||
                     'unknown';

      return {
        gateway: this.gatewayName,
        paymentId: metadata.payment_id?.toString() ||
                   successfulPayment?.telegram_payment_charge_id ||
                   preCheckoutQuery?.id ||
                   data.update_id.toString(),
        externalId: successfulPayment?.telegram_payment_charge_id ||
                    preCheckoutQuery?.id ||
                    data.update_id.toString(),
        status,
        amount: (successfulPayment?.total_amount || preCheckoutQuery?.total_amount || 0) / 100, // Convert from smallest units
        currency: successfulPayment?.currency || preCheckoutQuery?.currency || 'XTR', // XTR = Telegram Stars
        metadata: {
          ...metadata,
          telegramUserId: userId,
          telegramUsername: preCheckoutQuery?.from?.username,
          providerPaymentChargeId: successfulPayment?.provider_payment_charge_id,
          isStarsPayment: true,
        },
        timestamp: data.message?.date ? new Date(data.message.date * 1000) : new Date(),
      };
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to parse Telegram Stars payload');
      throw new Error('Invalid Telegram Stars webhook payload');
    }
  }
}
