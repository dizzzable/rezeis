import { Injectable } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { ListSubscriptionsQueryDto } from '../dto/list-subscriptions-query.dto';
import {
  AdminSubscriptionListItemInterface,
  AdminSubscriptionStatsInterface,
  AdminSubscriptionsListInterface,
} from '../interfaces/admin-subscriptions-list.interface';

const SUBSCRIPTION_USER_SELECT = {
  id: true,
  name: true,
  telegramId: true,
} as const;

const SUBSCRIPTION_INCLUDE = {
  user: { select: SUBSCRIPTION_USER_SELECT },
} as const;

type SubscriptionRecord = Prisma.SubscriptionGetPayload<{
  include: typeof SUBSCRIPTION_INCLUDE;
}>;

const DEFAULT_LIMIT = 50;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Read-only list/stats endpoints for the admin Subscriptions page. Kept
 * separate from `SubscriptionQuoteService` (which serves the
 * action-policy / quote computations) so the two responsibilities can
 * evolve independently.
 */
@Injectable()
export class AdminSubscriptionsListService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async list(
    query: ListSubscriptionsQueryDto,
  ): Promise<AdminSubscriptionsListInterface> {
    const where: Prisma.SubscriptionWhereInput = {};
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.isTrial === 'true') {
      where.isTrial = true;
    } else if (query.isTrial === 'false') {
      where.isTrial = false;
    }

    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;

    const [records, total] = await Promise.all([
      this.prismaService.subscription.findMany({
        where,
        include: SUBSCRIPTION_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prismaService.subscription.count({ where }),
    ]);

    return {
      items: records.map(mapSubscription),
      total,
    };
  }

  public async getStats(): Promise<AdminSubscriptionStatsInterface> {
    const now = new Date();
    const horizon = new Date(now.getTime() + SEVEN_DAYS_MS);

    const [total, statusGroups, trialCount, expiringIn7d] = await Promise.all([
      this.prismaService.subscription.count(),
      this.prismaService.subscription.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prismaService.subscription.count({ where: { isTrial: true } }),
      this.prismaService.subscription.count({
        where: {
          status: SubscriptionStatus.ACTIVE,
          expiresAt: { gte: now, lte: horizon },
        },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const entry of statusGroups) {
      byStatus[entry.status] = entry._count._all;
    }

    return {
      total,
      byStatus,
      trialCount,
      expiringIn7d,
      generatedAt: now.toISOString(),
    };
  }
}

function mapSubscription(
  record: SubscriptionRecord,
): AdminSubscriptionListItemInterface {
  const expiresAtIso = record.expiresAt?.toISOString() ?? null;
  return {
    id: record.id,
    status: record.status,
    isTrial: record.isTrial,
    trafficLimit: record.trafficLimit,
    deviceLimit: record.deviceLimit,
    expireAt: expiresAtIso,
    expiresAt: expiresAtIso,
    createdAt: record.createdAt.toISOString(),
    user: record.user
      ? {
          id: record.user.id,
          name: record.user.name === '' ? null : record.user.name,
        }
      : null,
    userTelegramId: record.user?.telegramId?.toString() ?? null,
    plan: { name: extractPlanName(record.planSnapshot) },
  };
}

function extractPlanName(snapshot: Prisma.JsonValue): string | null {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }
  const name = (snapshot as Record<string, unknown>)['name'];
  return typeof name === 'string' && name.length > 0 ? name : null;
}
