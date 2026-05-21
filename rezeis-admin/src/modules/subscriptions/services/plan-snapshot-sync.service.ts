import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import { TrafficLimitStrategyValue } from '../../plans/dto/traffic-limit-strategy.dto';

interface SnapshotSyncPlanInput {
  readonly id: string;
  readonly name: string;
  readonly tag: string | null;
  readonly type: string;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: TrafficLimitStrategyValue;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
}

type SubscriptionSnapshotRow = {
  readonly id: string;
  readonly planSnapshot: Prisma.JsonValue;
};

@Injectable()
export class PlanSnapshotSyncService {
  public async syncPlanSnapshotMetadata(
    prismaClient: Prisma.TransactionClient | PrismaClient,
    plan: SnapshotSyncPlanInput,
  ): Promise<number> {
    const subscriptions = await prismaClient.$queryRaw<readonly SubscriptionSnapshotRow[]>(
      Prisma.sql`
        SELECT "id", "plan_snapshot" AS "planSnapshot"
        FROM "subscriptions"
        WHERE "plan_snapshot"->>'id' = ${plan.id}
      `,
    );

    let updatedCount = 0;
    for (const subscription of subscriptions) {
      const planSnapshot =
        isJsonObject(subscription.planSnapshot) ? { ...subscription.planSnapshot } : {};
      planSnapshot.name = plan.name;
      planSnapshot.tag = plan.tag;
      planSnapshot.type = plan.type;
      planSnapshot.trafficLimit = plan.trafficLimit;
      planSnapshot.deviceLimit = plan.deviceLimit;
      planSnapshot.trafficLimitStrategy = plan.trafficLimitStrategy;
      planSnapshot.internalSquads = [...plan.internalSquads];
      planSnapshot.externalSquad = plan.externalSquad;
      await prismaClient.subscription.update({
        where: {
          id: subscription.id,
        },
        data: {
          planSnapshot,
        },
      });
      updatedCount += 1;
    }
    return updatedCount;
  }
}

function isJsonObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
