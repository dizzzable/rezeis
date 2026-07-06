import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import {
  PAYMENT_RECONCILIATION_CONCURRENCY,
  PAYMENT_RECONCILIATION_JOB,
  PAYMENT_RECONCILIATION_QUEUE,
} from '../constants/payment-reconciliation.constant';
import { PaymentReconciliationService } from '../services/payment-reconciliation.service';

@Processor(PAYMENT_RECONCILIATION_QUEUE, { concurrency: PAYMENT_RECONCILIATION_CONCURRENCY })
export class PaymentReconciliationProcessor extends WorkerHost {
  public constructor(
    private readonly paymentReconciliationService: PaymentReconciliationService,
  ) {
    super();
  }

  public override async process(job: Job): Promise<void> {
    if (job.name !== PAYMENT_RECONCILIATION_JOB) {
      return;
    }
    const eventId = readEventId(job.data);
    await this.paymentReconciliationService.reconcileWebhookEvent(eventId);
  }
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
