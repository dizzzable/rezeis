/**
 * Payment gateway abstraction.
 *
 * Every gateway adapter implements this interface.
 * The registry maps PaymentGatewayType → adapter instance.
 */

import type { Request } from 'express';

// ── Checkout ──────────────────────────────────────────────────────────────────

export interface GatewayCheckoutInput {
  /** Our internal payment UUID */
  paymentId: string;
  /** Amount in the gateway's currency (e.g. RUB) */
  amount: number;
  currency: string;
  /** Short description shown on the payment page */
  description: string;
  /** URL to redirect after success */
  successUrl?: string;
  /** URL to redirect after failure */
  failUrl?: string;
  /** Customer email (required by most gateways) */
  customerEmail?: string;
  /** Customer phone */
  customerPhone?: string;
  /** Arbitrary metadata passed through */
  metadata?: Record<string, string>;
}

export interface GatewayCheckoutResult {
  /** External payment ID assigned by the gateway */
  externalPaymentId: string;
  /** URL to redirect the user to for payment */
  paymentUrl: string;
  /** Raw gateway response for logging */
  raw?: unknown;
}

// ── Webhook ───────────────────────────────────────────────────────────────────

export type WebhookEventStatus = 'SUCCESS' | 'FAILED' | 'PENDING' | 'REFUNDED' | 'CANCELED';

export interface NormalizedWebhookEvent {
  /** Our internal payment UUID (order_id we sent to the gateway) */
  paymentId: string;
  /** Gateway's own payment identifier */
  externalPaymentId: string;
  status: WebhookEventStatus;
  /** Amount actually paid */
  amount?: number;
  currency?: string;
  /** Raw event type string from the gateway */
  eventType?: string;
  /** Full raw payload for audit */
  raw: unknown;
}

export interface WebhookVerifyResult {
  /** Whether the signature / secret is valid */
  valid: boolean;
  /** Reason for failure (for logging) */
  reason?: string;
}

// ── Gateway interface ─────────────────────────────────────────────────────────

export interface IPaymentGateway {
  /** Unique identifier matching PaymentGatewayType enum */
  readonly type: string;

  /**
   * Create a payment session and return the checkout URL.
   * Called when a user initiates a purchase.
   */
  createCheckout(input: GatewayCheckoutInput, settings: Record<string, unknown>): Promise<GatewayCheckoutResult>;

  /**
   * Verify the incoming webhook request signature.
   * Called before processing the event.
   */
  verifyWebhook(req: Request, settings: Record<string, unknown>): Promise<WebhookVerifyResult>;

  /**
   * Parse and normalize the webhook payload into a standard event.
   * Called after signature verification passes.
   */
  parseWebhook(req: Request): Promise<NormalizedWebhookEvent>;

  /**
   * Optional: check payment status by polling the gateway API.
   * Used as a fallback when webhooks are unreliable.
   */
  checkPaymentStatus?(externalPaymentId: string, settings: Record<string, unknown>): Promise<WebhookEventStatus>;
}
