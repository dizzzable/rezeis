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
      const { gatewayType, providerSubscriptionId } = readSyncTarget(job.data);
      await this.providerSubscriptionService.sync(gatewayType, providerSubscriptionId);
      return;
    }
    if (job.name !== PAYMENT_RECONCILIATION_JOB) {
      return;
    }
    const eventId = readEventId(job.data);
    await this.paymentReconciliationService.reconcileWebhookEvent(eventId);
  }
}

function readSyncTarget(data: unknown): {
  readonly gatewayType: PaymentGatewayType;
  readonly providerSubscriptionId: string;
} {
  const record =
    typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const gatewayType = record.gatewayType;
  const providerSubscriptionId = record.providerSubscriptionId;
  if (
    !(Object.values(PaymentGatewayType) as unknown[]).includes(gatewayType) ||
    typeof providerSubscriptionId !== 'string' ||
    providerSubscriptionId.length === 0
  ) {
    throw new Error('Provider subscription sync job payload is invalid');
  }
  return { gatewayType: gatewayType as PaymentGatewayType, providerSubscriptionId };
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
