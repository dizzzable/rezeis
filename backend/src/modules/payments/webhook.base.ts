import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { logger } from '../../utils/logger.js';
import { getCacheService } from '../../cache/cache.service.js';
import { eventService } from '../../events/event.service.js';
import type { WebhookPayload, WebhookResult, PaymentType } from './types.js';

/**
 * Webhook handler error
 */
export class WebhookHandlerError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'WebhookHandlerError';
  }
}

/**
 * Abstract base class for payment webhook handlers
 * All payment gateway handlers must extend this class
 */
export abstract class PaymentWebhookHandler {
  /** Gateway name identifier */
  abstract readonly gatewayName: string;

  /** Cache service for idempotency checks */
  protected readonly cacheService = getCacheService();

  /** Idempotency key TTL in seconds (24 hours) */
  private readonly idempotencyTtl = 24 * 60 * 60;

  /**
   * Validate webhook signature
   * @param payload - Raw request body or parsed payload
   * @param signature - Signature from headers
   * @param secret - Webhook secret from configuration
   * @returns True if signature is valid
   */
  abstract validateSignature(payload: unknown, signature: string, secret: string): boolean;

  /**
   * Parse webhook payload into standardized format
   * @param body - Raw request body
   * @returns Standardized webhook payload
   */
  abstract parsePayload(body: unknown): WebhookPayload;

  /**
   * Validate signature using HMAC-SHA256
   * @param payload - Payload to validate
   * @param signature - Expected signature
   * @param secret - Secret key
   * @param signaturePrefix - Optional prefix to strip from signature (e.g., 'sha256=')
   * @returns True if valid
   */
  protected validateHmacSignature(
    payload: string,
    signature: string,
    secret: string,
    signaturePrefix?: string
  ): boolean {
    try {
      let expectedSignature = signature;
      if (signaturePrefix && signature.startsWith(signaturePrefix)) {
        expectedSignature = signature.slice(signaturePrefix.length);
      }

      const hmac = createHmac('sha256', secret);
      hmac.update(payload, 'utf8');
      const computedSignature = hmac.digest('hex');

      // Use timing-safe comparison to prevent timing attacks
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');
      const computedBuffer = Buffer.from(computedSignature, 'hex');

      if (expectedBuffer.length !== computedBuffer.length) {
        return false;
      }

      return timingSafeEqual(expectedBuffer, computedBuffer);
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to validate HMAC signature');
      return false;
    }
  }

  /**
   * Validate signature using HMAC-SHA512
   * @param payload - Payload to validate
   * @param signature - Expected signature
   * @param secret - Secret key
   * @returns True if valid
   */
  protected validateHmacSha512Signature(payload: string, signature: string, secret: string): boolean {
    try {
      const hmac = createHmac('sha512', secret);
      hmac.update(payload, 'utf8');
      const computedSignature = hmac.digest('hex');

      const expectedBuffer = Buffer.from(signature, 'hex');
      const computedBuffer = Buffer.from(computedSignature, 'hex');

      if (expectedBuffer.length !== computedBuffer.length) {
        return false;
      }

      return timingSafeEqual(expectedBuffer, computedBuffer);
    } catch (error) {
      logger.error({ error, gateway: this.gatewayName }, 'Failed to validate HMAC-SHA512 signature');
      return false;
    }
  }

  /**
   * Compute SHA-256 hash
   * @param data - Data to hash
   * @returns Hex encoded hash
   */
  protected computeSha256(data: string): string {
    return createHash('sha256').update(data, 'utf8').digest('hex');
  }

  /**
   * Compute MD5 hash
   * @param data - Data to hash
   * @returns Hex encoded hash
   */
  protected computeMd5(data: string): string {
    return createHash('md5').update(data, 'utf8').digest('hex');
  }

  /**
   * Check if webhook has already been processed (idempotency)
   * @param gateway - Gateway name
   * @param externalId - External payment ID
   * @returns True if already processed
   */
  protected async isDuplicate(gateway: string, externalId: string): Promise<boolean> {
    const cacheKey = `webhook:processed:${gateway}:${externalId}`;
    const exists = await this.cacheService.get(cacheKey);
    return exists !== null;
  }

  /**
   * Mark webhook as processed for idempotency
   * @param gateway - Gateway name
   * @param externalId - External payment ID
   */
  protected async markAsProcessed(gateway: string, externalId: string): Promise<void> {
    const cacheKey = `webhook:processed:${gateway}:${externalId}`;
    await this.cacheService.set(cacheKey, '1', this.idempotencyTtl);
  }

  /**
   * Process successful payment webhook
   * @param payload - Standardized webhook payload
   * @returns Webhook processing result
   */
  async handleSuccess(payload: WebhookPayload): Promise<WebhookResult> {
    const startTime = Date.now();

    try {
      // Check for duplicate webhook
      if (await this.isDuplicate(payload.gateway, payload.externalId)) {
        logger.info({ gateway: payload.gateway, externalId: payload.externalId }, 'Duplicate webhook detected, skipping');
        return {
          success: true,
          message: 'Webhook already processed',
          paymentId: payload.paymentId,
          statusCode: 200,
        };
      }

      logger.info({
        gateway: payload.gateway,
        paymentId: payload.paymentId,
        externalId: payload.externalId,
        amount: payload.amount,
        currency: payload.currency,
      }, 'Processing successful payment webhook');

      // Mark as processed for idempotency
      await this.markAsProcessed(payload.gateway, payload.externalId);

      const duration = Date.now() - startTime;
      logger.info({
        gateway: payload.gateway,
        paymentId: payload.paymentId,
        duration,
      }, 'Successfully processed payment webhook');

      return {
        success: true,
        message: 'Payment processed successfully',
        paymentId: payload.paymentId,
        statusCode: 200,
      };
    } catch (error) {
      logger.error({
        error,
        gateway: payload.gateway,
        paymentId: payload.paymentId,
      }, 'Failed to process successful payment webhook');

      throw new WebhookHandlerError(
        'Failed to process payment webhook',
        error,
        500
      );
    }
  }

  /**
   * Process failed payment webhook
   * @param payload - Standardized webhook payload
   * @returns Webhook processing result
   */
  async handleFailure(payload: WebhookPayload): Promise<WebhookResult> {
    try {
      // Check for duplicate webhook
      if (await this.isDuplicate(payload.gateway, payload.externalId)) {
        return {
          success: true,
          message: 'Webhook already processed',
          paymentId: payload.paymentId,
          statusCode: 200,
        };
      }

      logger.info({
        gateway: payload.gateway,
        paymentId: payload.paymentId,
        externalId: payload.externalId,
        error: payload.errorMessage,
      }, 'Processing failed payment webhook');

      // Mark as processed for idempotency
      await this.markAsProcessed(payload.gateway, payload.externalId);

      return {
        success: true,
        message: 'Payment failure recorded',
        paymentId: payload.paymentId,
        statusCode: 200,
      };
    } catch (error) {
      logger.error({
        error,
        gateway: payload.gateway,
        paymentId: payload.paymentId,
      }, 'Failed to process failed payment webhook');

      throw new WebhookHandlerError(
        'Failed to process payment failure webhook',
        error,
        500
      );
    }
  }

  /**
   * Process pending payment webhook
   * @param payload - Standardized webhook payload
   * @returns Webhook processing result
   */
  async handlePending(payload: WebhookPayload): Promise<WebhookResult> {
    try {
      logger.info({
        gateway: payload.gateway,
        paymentId: payload.paymentId,
        externalId: payload.externalId,
      }, 'Processing pending payment webhook');

      return {
        success: true,
        message: 'Payment pending status recorded',
        paymentId: payload.paymentId,
        statusCode: 200,
      };
    } catch (error) {
      logger.error({
        error,
        gateway: payload.gateway,
        paymentId: payload.paymentId,
      }, 'Failed to process pending payment webhook');

      throw new WebhookHandlerError(
        'Failed to process pending payment webhook',
        error,
        500
      );
    }
  }

  /**
   * Route webhook to appropriate handler based on status
   * @param payload - Standardized webhook payload
   * @returns Webhook processing result
   */
  async processWebhook(payload: WebhookPayload): Promise<WebhookResult> {
    switch (payload.status) {
      case 'success':
        return this.handleSuccess(payload);
      case 'failed':
        return this.handleFailure(payload);
      case 'pending':
        return this.handlePending(payload);
      default:
        logger.warn({ status: payload.status, gateway: payload.gateway }, 'Unknown payment status');
        return {
          success: false,
          message: `Unknown payment status: ${payload.status}`,
          statusCode: 400,
        };
    }
  }

  /**
   * Send payment notification to user via WebSocket
   * @param userId - User ID
   * @param payload - Payment payload
   * @param type - Payment type
   */
  protected async sendPaymentNotification(
    userId: string,
    payload: WebhookPayload,
    _type: PaymentType
  ): Promise<void> {
    try {
      await eventService.emitPaymentReceived(userId, {
        paymentId: payload.paymentId,
        amount: payload.amount,
        currency: payload.currency,
        status: payload.status,
      });
    } catch (error) {
      logger.error({ error, userId, paymentId: payload.paymentId }, 'Failed to send payment notification');
    }
  }

  /**
   * Send payment failure notification to user
   * @param userId - User ID
   * @param payload - Payment payload
   * @param reason - Failure reason
   */
  protected async sendPaymentFailureNotification(
    userId: string,
    payload: WebhookPayload,
    reason: string
  ): Promise<void> {
    try {
      await eventService.emitPaymentFailed(userId, payload.paymentId, reason);
    } catch (error) {
      logger.error({ error, userId, paymentId: payload.paymentId }, 'Failed to send payment failure notification');
    }
  }
}
