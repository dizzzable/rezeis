import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Optional } from '@nestjs/common';
import { PaymentGatewayType } from '@prisma/client';
import { Job } from 'bullmq';

import {
  ANTILOPAY_PAYMENT_CHECK_JOB,
  PAYMENT_RECONCILIATION_CONCURRENCY,
  PAYMENT_RECONCILIATION_JOB,
  PAYMENT_RECONCILIATION_QUEUE,
  PROVIDER_SUBSCRIPTION_SYNC_JOB,
} from '../constants/payment-reconciliation.constant';
import { AntilopayStatusService } from '../services/antilopay-status.service';
import { PaymentReconciliationService } from '../services/payment-reconciliation.service';
import { ProviderSubscriptionService } from '../services/provider-subscription.service';

@Processor(PAYMENT_RECONCILIATION_QUEUE, { concurrency: PAYMENT_RECONCILIATION_CONCURRENCY })
export class PaymentReconciliationProcessor extends WorkerHost {
  public constructor(
    private readonly paymentReconciliationService: PaymentReconciliationService,
    private readonly providerSubscriptionService: ProviderSubscriptionService,
    /**
     * Looks at an Antilopay payment a refund's callback named. Last and
     * optional: specs build this positionally.
     */
    @Optional()
    private readonly antilopayStatusService?: AntilopayStatusService,
  ) {
    super();
  }

  public override async process(job: Job): Promise<void> {
    if (job.name === PROVIDER_SUBSCRIPTION_SYNC_JOB) {
      const target = readSyncTarget(job.data);
      if ('providerPaymentId' in target) {
        await this.providerSubscriptionService.syncByPayment(target.gatewayType, target.providerPaymentId);
      } else if ('providerRecurrentId' in target) {
        await this.providerSubscriptionService.syncByRecurrent(
          target.gatewayType,
          target.providerRecurrentId,
          target.orderId,
          { paymentId: target.paymentId, status: target.status },
        );
      } else {
        await this.providerSubscriptionService.sync(target.gatewayType, target.providerSubscriptionId);
      }
      return;
    }
    if (job.name === ANTILOPAY_PAYMENT_CHECK_JOB) {
      const orderId = (job.data as { orderId?: unknown } | null | undefined)?.orderId;
      if (typeof orderId !== 'string' || orderId.length === 0) {
        throw new Error('Antilopay payment check job payload is invalid');
      }
      await this.antilopayStatusService?.checkByOrder(orderId);
      return;
    }
    if (job.name !== PAYMENT_RECONCILIATION_JOB) {
      return;
    }
    const eventId = readEventId(job.data);
    await this.paymentReconciliationService.reconcileWebhookEvent(eventId);
  }
}

/**
 * A look at one subscription, at whichever one a provider payment belongs to,
 * or at the Antilopay one a callback names by its recurrent id (with our order
 * when the callback names one).
 */
function readSyncTarget(
  data: unknown,
):
  | { readonly gatewayType: PaymentGatewayType; readonly providerSubscriptionId: string }
  | { readonly gatewayType: PaymentGatewayType; readonly providerPaymentId: string }
  | {
      readonly gatewayType: PaymentGatewayType;
      readonly providerRecurrentId: string;
      readonly orderId: string | null;
      readonly paymentId: string | null;
      readonly status: string | null;
    } {
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
  const providerRecurrentId = record.providerRecurrentId;
  if (typeof providerRecurrentId === 'string' && providerRecurrentId.length > 0) {
    const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
    return {
      gatewayType: gatewayType as PaymentGatewayType,
      providerRecurrentId,
      orderId: text(record.orderId),
      paymentId: text(record.paymentId),
      status: text(record.status),
    };
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
