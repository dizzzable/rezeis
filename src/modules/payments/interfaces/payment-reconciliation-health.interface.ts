import { PaymentWebhookLifecycleStatus } from '@prisma/client';

export interface PaymentReconciliationQueueCountsInterface {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly completed: number;
  readonly failed: number;
}

export interface PaymentReconciliationHealthInterface {
  readonly queue: PaymentReconciliationQueueCountsInterface;
  readonly eventsByStatus: Readonly<Record<PaymentWebhookLifecycleStatus, number>>;
  readonly staleProcessingCount: number;
  readonly staleEnqueuedCount: number;
  readonly generatedAt: string;
}
