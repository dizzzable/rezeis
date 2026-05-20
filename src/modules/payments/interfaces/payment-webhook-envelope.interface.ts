import {
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
} from '@prisma/client';

export interface PaymentWebhookEnvelopeInterface {
  readonly gatewayType: PaymentGatewayType;
  readonly paymentId: string;
  readonly providerEventId: string;
  readonly eventStatus: string | null;
  readonly receivedAt: string;
  readonly payloadHash: string;
  readonly rawPayload: Record<string, unknown>;
}

export interface PaymentWebhookIngressResultInterface {
  readonly accepted: true;
  readonly duplicate: boolean;
  readonly lifecycleStatus: PaymentWebhookLifecycleStatus;
  readonly envelope: PaymentWebhookEnvelopeInterface;
}
