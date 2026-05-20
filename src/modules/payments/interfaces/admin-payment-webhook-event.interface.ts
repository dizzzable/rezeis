import {
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
} from '@prisma/client';

export interface AdminPaymentWebhookEventListItemInterface {
  readonly id: string;
  readonly gatewayType: PaymentGatewayType;
  readonly paymentId: string;
  readonly providerEventId: string;
  readonly eventStatus: string | null;
  readonly status: PaymentWebhookLifecycleStatus;
  readonly attempts: number;
  readonly reconciliationAttempts: number;
  readonly replayCount: number;
  readonly lastError: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  readonly lastTransitionAt: string;
  readonly lastReplayedAt: string | null;
}

export interface AdminPaymentWebhookEventDetailInterface
  extends AdminPaymentWebhookEventListItemInterface {
  readonly payloadHash: string | null;
  readonly redactedPayload: unknown;
  readonly rawPayload: unknown | null;
}

export interface AdminReplayPaymentWebhookEventResultInterface {
  readonly event: AdminPaymentWebhookEventListItemInterface;
  readonly alreadyQueued: boolean;
}
