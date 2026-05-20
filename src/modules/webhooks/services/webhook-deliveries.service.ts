import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, WebhookDeliveryStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunSchedules } from '../../../common/runtime/process-role.util';

const RETENTION_DAYS = 30;

export interface WebhookDeliveryListItem {
  readonly id: string;
  readonly subscriptionId: string;
  readonly subscriptionName: string;
  readonly eventType: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempt: number;
  readonly httpStatus: number | null;
  readonly responseBody: string | null;
  readonly errorMessage: string | null;
  readonly durationMs: number | null;
  readonly nextRetryAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

export interface WebhookDeliveryDetail extends WebhookDeliveryListItem {
  readonly payload: unknown;
}

export interface ListDeliveriesQuery {
  readonly subscriptionId?: string;
  readonly status?: WebhookDeliveryStatus;
  readonly eventType?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListDeliveriesResult {
  readonly items: readonly WebhookDeliveryListItem[];
  readonly nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Read-side service for the deliveries table. Mutating writes happen in
 * `WebhookDispatcherService` so all transitions stay in one place.
 */
@Injectable()
export class WebhookDeliveriesService {
  private readonly logger = new Logger(WebhookDeliveriesService.name);

  public constructor(private readonly prismaService: PrismaService) {}

  public async list(query: ListDeliveriesQuery): Promise<ListDeliveriesResult> {
    const limit = clamp(query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const where: Prisma.WebhookDeliveryWhereInput = {};
    if (query.subscriptionId) where.subscriptionId = query.subscriptionId;
    if (query.status) where.status = query.status;
    if (query.eventType) where.eventType = query.eventType;

    const rows = await this.prismaService.webhookDelivery.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      include: {
        subscription: { select: { name: true } },
      },
    });

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: slice.map(toListItem),
      nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
    };
  }

  public async getById(id: string): Promise<WebhookDeliveryDetail> {
    const row = await this.prismaService.webhookDelivery.findUnique({
      where: { id },
      include: { subscription: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('Delivery not found');
    return {
      ...toListItem(row),
      payload: row.payload,
    };
  }

  /**
   * Daily cleanup — drops finished deliveries older than `RETENTION_DAYS`
   * so the table stays bounded.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  public async cleanupOldDeliveries(): Promise<void> {
    if (!shouldRunSchedules()) return;
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.prismaService.webhookDelivery.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        status: { in: [WebhookDeliveryStatus.SUCCEEDED, WebhookDeliveryStatus.FAILED] },
      },
    });
    if (count > 0) {
      this.logger.log(`Webhook deliveries cleanup: ${count} rows removed`);
    }
  }
}

function toListItem(row: {
  id: string;
  subscriptionId: string;
  subscription?: { name: string } | null;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempt: number;
  httpStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  nextRetryAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}): WebhookDeliveryListItem {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    subscriptionName: row.subscription?.name ?? '',
    eventType: row.eventType,
    status: row.status,
    attempt: row.attempt,
    httpStatus: row.httpStatus,
    responseBody: row.responseBody,
    errorMessage: row.errorMessage,
    durationMs: row.durationMs,
    nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
