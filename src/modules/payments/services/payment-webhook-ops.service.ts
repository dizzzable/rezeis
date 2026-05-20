import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  PaymentWebhookEvent,
  PaymentWebhookLifecycleStatus,
  Prisma,
} from '@prisma/client';
import { Queue } from 'bullmq';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { CurrentAdminInterface } from '../../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../../auth/interfaces/request-metadata.interface';
import {
  PAYMENT_RECONCILIATION_JOB,
  PAYMENT_RECONCILIATION_QUEUE,
} from '../constants/payment-reconciliation.constant';
import { ListPaymentWebhookEventsQueryDto } from '../dto/list-payment-webhook-events-query.dto';
import {
  AdminPaymentWebhookEventDetailInterface,
  AdminPaymentWebhookEventListItemInterface,
  AdminReplayPaymentWebhookEventResultInterface,
} from '../interfaces/admin-payment-webhook-event.interface';
import { PaymentReconciliationHealthInterface } from '../interfaces/payment-reconciliation-health.interface';
import { PaymentWebhookPayloadRedactionService } from './payment-webhook-payload-redaction.service';
import { PaymentWebhookInboxService } from './payment-webhook-inbox.service';
import { PaymentOpsAlertService } from './payment-ops-alert.service';

const ENQUEUED_STALE_MINUTES = 10;
const PROCESSING_STALE_MINUTES = 15;

@Injectable()
export class PaymentWebhookOpsService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly paymentWebhookInboxService: PaymentWebhookInboxService,
    private readonly paymentWebhookPayloadRedactionService: PaymentWebhookPayloadRedactionService,
    private readonly paymentOpsAlertService: PaymentOpsAlertService,
    @InjectQueue(PAYMENT_RECONCILIATION_QUEUE)
    private readonly paymentReconciliationQueue: Queue,
  ) {}

  public async listEvents(
    query: ListPaymentWebhookEventsQueryDto,
  ): Promise<readonly AdminPaymentWebhookEventListItemInterface[]> {
    const events = await this.prismaService.paymentWebhookEvent.findMany({
      where: buildEventsWhere(query),
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: query.limit ?? 100,
      skip: query.offset ?? 0,
    } as never);
    return events.map((event) => mapEventListItem(event));
  }

  public async getEventDetail(input: {
    readonly eventId: string;
    readonly includeRaw: boolean;
  }): Promise<AdminPaymentWebhookEventDetailInterface> {
    const event = await this.prismaService.paymentWebhookEvent.findUnique({
      where: { id: input.eventId },
    });
    if (event === null) {
      throw new NotFoundException('Payment webhook event not found');
    }
    return {
      ...mapEventListItem(event),
      payloadHash: event.payloadHash,
      redactedPayload: this.paymentWebhookPayloadRedactionService.redact(event.rawPayload),
      rawPayload: input.includeRaw ? event.rawPayload : null,
    };
  }

  public async replayEvent(input: {
    readonly eventId: string;
    readonly reason: string;
    readonly force: boolean;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<AdminReplayPaymentWebhookEventResultInterface> {
    const event = await this.prismaService.paymentWebhookEvent.findUnique({
      where: { id: input.eventId },
    });
    if (event === null) {
      throw new NotFoundException('Payment webhook event not found');
    }
    validateReplayPolicy({
      status: event.status as PaymentWebhookLifecycleStatus,
      force: input.force,
    });
    const jobId = buildReconciliationJobId(event.id);
    const alreadyQueued = await this.isAlreadyQueued(jobId);
    const updatedEvent = alreadyQueued
      ? event
      : await this.paymentWebhookInboxService.markReplayRequested(event.id);
    if (!alreadyQueued) {
      await this.paymentReconciliationQueue.add(
        PAYMENT_RECONCILIATION_JOB,
        {
          eventId: event.id,
          paymentId: event.paymentId,
          gatewayType: event.gatewayType,
        },
        {
          jobId,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    }
    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'payments.webhook.replay.requested',
        ipAddress: input.requestMetadata.remoteAddress,
        userAgent: input.requestMetadata.userAgent,
        metadata: {
          requestId: input.requestMetadata.requestId,
          eventId: event.id,
          paymentId: event.paymentId,
          providerEventId: event.providerEventId,
          statusBefore: event.status,
          force: input.force,
          reason: input.reason,
          alreadyQueued,
        },
        adminUser: { connect: { id: input.currentAdmin.id } },
      } as never,
    });
    await this.paymentOpsAlertService.notifyWebhookReplay({
      event: updatedEvent,
      context: {
        reason: input.reason,
        force: input.force,
      },
    });
    return {
      event: mapEventListItem(updatedEvent),
      alreadyQueued,
    };
  }

  public async getReconciliationHealth(): Promise<PaymentReconciliationHealthInterface> {
    const queueCounts = await this.paymentReconciliationQueue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
    );
    const groupedStatus = await this.prismaService.paymentWebhookEvent.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    const eventsByStatus: Record<PaymentWebhookLifecycleStatus, number> = {
      [PaymentWebhookLifecycleStatus.RECEIVED]: 0,
      [PaymentWebhookLifecycleStatus.ENQUEUED]: 0,
      [PaymentWebhookLifecycleStatus.PROCESSING]: 0,
      [PaymentWebhookLifecycleStatus.PROCESSED]: 0,
      [PaymentWebhookLifecycleStatus.FAILED]: 0,
    };
    for (const row of groupedStatus as ReadonlyArray<{
      readonly status: PaymentWebhookLifecycleStatus;
      readonly _count: { readonly _all: number };
    }>) {
      eventsByStatus[row.status] = row._count._all;
    }

    const staleEnqueuedCount = await this.prismaService.paymentWebhookEvent.count({
      where: {
        status: PaymentWebhookLifecycleStatus.ENQUEUED,
        lastTransitionAt: {
          lt: subtractMinutes(new Date(), ENQUEUED_STALE_MINUTES),
        },
      } as never,
    });
    const staleProcessingCount = await this.prismaService.paymentWebhookEvent.count({
      where: {
        status: PaymentWebhookLifecycleStatus.PROCESSING,
        lastTransitionAt: {
          lt: subtractMinutes(new Date(), PROCESSING_STALE_MINUTES),
        },
      } as never,
    });

    return {
      queue: {
        waiting: queueCounts.waiting ?? 0,
        active: queueCounts.active ?? 0,
        delayed: queueCounts.delayed ?? 0,
        completed: queueCounts.completed ?? 0,
        failed: queueCounts.failed ?? 0,
      },
      eventsByStatus,
      staleEnqueuedCount,
      staleProcessingCount,
      generatedAt: new Date().toISOString(),
    };
  }

  public async auditPayloadReveal(input: {
    readonly eventId: string;
    readonly currentAdmin: CurrentAdminInterface;
    readonly requestMetadata: RequestMetadataInterface;
  }): Promise<void> {
    await this.prismaService.adminAuditLog.create({
      data: {
        action: 'payments.webhook.payload.revealed',
        ipAddress: input.requestMetadata.remoteAddress,
        userAgent: input.requestMetadata.userAgent,
        metadata: {
          requestId: input.requestMetadata.requestId,
          eventId: input.eventId,
        },
        adminUser: { connect: { id: input.currentAdmin.id } },
      } as never,
    });
  }

  private async isAlreadyQueued(jobId: string): Promise<boolean> {
    const job = await this.paymentReconciliationQueue.getJob(jobId);
    if (job === undefined || job === null) {
      return false;
    }
    const state = await job.getState();
    return (
      state === 'waiting' ||
      state === 'active' ||
      state === 'delayed' ||
      state === 'prioritized'
    );
  }
}

function buildEventsWhere(
  query: ListPaymentWebhookEventsQueryDto,
): Prisma.PaymentWebhookEventWhereInput {
  const receivedAt: Prisma.DateTimeFilter = {};
  if (query.from !== undefined) {
    receivedAt.gte = new Date(query.from);
  }
  if (query.to !== undefined) {
    receivedAt.lte = new Date(query.to);
  }
  return {
    gatewayType: query.gatewayType,
    status: query.status,
    paymentId: query.paymentId,
    providerEventId: query.providerEventId,
    receivedAt: Object.keys(receivedAt).length > 0 ? receivedAt : undefined,
  };
}

function mapEventListItem(
  event: PaymentWebhookEvent,
): AdminPaymentWebhookEventListItemInterface {
  const enrichedEvent = event as PaymentWebhookEvent & {
    readonly reconciliationAttempts?: number;
    readonly replayCount?: number;
    readonly lastTransitionAt?: Date;
    readonly lastReplayedAt?: Date | null;
  };
  return {
    id: event.id,
    gatewayType: event.gatewayType,
    paymentId: event.paymentId,
    providerEventId: event.providerEventId,
    eventStatus: event.eventStatus,
    status: event.status as PaymentWebhookLifecycleStatus,
    attempts: event.attempts,
    reconciliationAttempts: enrichedEvent.reconciliationAttempts ?? 0,
    replayCount: enrichedEvent.replayCount ?? 0,
    lastError: event.lastError,
    receivedAt: event.receivedAt.toISOString(),
    processedAt: event.processedAt?.toISOString() ?? null,
    lastTransitionAt:
      enrichedEvent.lastTransitionAt?.toISOString() ??
      event.receivedAt.toISOString(),
    lastReplayedAt: enrichedEvent.lastReplayedAt?.toISOString() ?? null,
  };
}

function validateReplayPolicy(input: {
  readonly status: PaymentWebhookLifecycleStatus;
  readonly force: boolean;
}): void {
  if (input.status === PaymentWebhookLifecycleStatus.PROCESSED && !input.force) {
    throw new BadRequestException('PAYMENT_WEBHOOK_REPLAY_FORCE_REQUIRED');
  }
  if (
    !input.force &&
    input.status !== PaymentWebhookLifecycleStatus.RECEIVED &&
    input.status !== PaymentWebhookLifecycleStatus.ENQUEUED &&
    input.status !== PaymentWebhookLifecycleStatus.PROCESSING &&
    input.status !== PaymentWebhookLifecycleStatus.FAILED
  ) {
    throw new BadRequestException('PAYMENT_WEBHOOK_REPLAY_NOT_ALLOWED');
  }
}

function buildReconciliationJobId(eventId: string): string {
  return `reconcile:webhook:${eventId}`;
}

function subtractMinutes(baseDate: Date, minutes: number): Date {
  return new Date(baseDate.getTime() - minutes * 60_000);
}
