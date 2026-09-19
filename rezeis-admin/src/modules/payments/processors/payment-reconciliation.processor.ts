import { Processor, WorkerHost } from '@nestjs/bullmq';
import { PaymentGatewayType } from '@prisma/client';
import { Job } from 'bullmq';

import {
  PAYMENT_RECONCILIATION_CONCURRENCY,
  PAYMENT_RECONCILIATION_JOB,
  PAYMENT_RECONCILIATION_QUEUE,
  PROVIDER_SUBSCRIPTION_SYNC_JOB,
} from '../constants/payment-reconciliation.constant';
import { PaymentReconciliationService } from '../services/payment-reconciliation.service';
import { ProviderSubscriptionService } from '../services/provider-subscription.service';

@Processor(PAYMENT_RECONCILIATION_QUEUE, { concurrency: PAYMENT_RECONCILIATION_CONCURRENCY })
export class PaymentReconciliationProcessor extends WorkerHost {
  public constructor(
    private readonly paymentReconciliationService: PaymentReconciliationService,
    private readonly providerSubscriptionService: ProviderSubscriptionService,
  ) {
    super();
  }

  public override async process(job: Job): Promise<void> {
    if (job.name === PROVIDER_SUBSCRIPTION_SYNC_JOB) {
      const target = readSyncTarget(job.data);
      if ('providerPaymentId' in target) {
        await this.providerSubscriptionService.syncByPayment(target.gatewayType, target.providerPaymentId);
      } else {
        await this.providerSubscriptionService.sync(target.gatewayType, target.providerSubscriptionId);
      }
      return;
    }
    if (job.name !== PAYMENT_RECONCILIATION_JOB) {
      return;
    }
    const eventId = readEventId(job.data);
    await this.paymentReconciliationService.reconcileWebhookEvent(eventId);
  }
}

/** A look at one subscription, or at whichever one a provider payment belongs to. */
function readSyncTarget(
  data: unknown,
):
  | { readonly gatewayType: PaymentGatewayType; readonly providerSubscriptionId: string }
  | { readonly gatewayType: PaymentGatewayType; readonly providerPaymentId: string } {
  const record =
    typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const gatewayType = record.gatewayType;
  if (!(Object.values(PaymentGatewayType) as unknown[]).includes(gatewayType)) {
    throw new Error('Provider subscription sync job payload is invalid');
  }
  const providerSubscriptionId = record.providerSubscriptionId;
  if (typeof providerSubscriptionId === 'string' && providerSubscriptionId.length > 0) {
    return { gatewayType: gatewayType as PaymentGatewayType, providerSubscriptionId };
  }
  const providerPaymentId = record.providerPaymentId;
  if (typeof providerPaymentId === 'string' && providerPaymentId.length > 0) {
    return { gatewayType: gatewayType as PaymentGatewayType, providerPaymentId };
  }
  throw new Error('Provider subscription sync job payload is invalid');
}

function readEventId(data: unknown): string {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Payment reconciliation job payload is invalid');
  }
  const eventId = (data as Record<string, unknown>).eventId;
  if (typeof eventId !== 'string' || eventId.length === 0) {
    throw new Error('Payment reconciliation job eventId is missing');
  }
  return eventId;
}
