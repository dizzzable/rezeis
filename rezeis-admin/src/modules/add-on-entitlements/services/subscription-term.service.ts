import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SubscriptionStatus, SubscriptionTermStatus, TrafficLimitStrategy } from '@prisma/client';

export interface CreateScheduledTermInput {
  readonly subscriptionId: string;
  readonly planId?: string;
  readonly planRevision?: number;
  readonly planSnapshot: Prisma.InputJsonValue;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly baseTrafficLimitBytes: bigint | null;
  readonly baseDeviceLimit: number | null;
  readonly trafficResetStrategy: TrafficLimitStrategy;
  readonly resetAnchorAt: Date | null;
}

export interface ScheduledTermResult {
  readonly id: string;
  readonly generation: number;
  readonly status: SubscriptionTermStatus;
}

export interface TermActivationResult {
  readonly id: string;
  readonly status: SubscriptionTermStatus;
  readonly changed: boolean;
}

type LockedTerm = {
  readonly id: string;
  readonly subscriptionId: string;
  readonly status: SubscriptionTermStatus;
  readonly subscriptionStatus: SubscriptionStatus;
  readonly generation: number;
  readonly startsAt: Date;
};

@Injectable()
export class SubscriptionTermService {
  public async createScheduledInTransaction(
    tx: Prisma.TransactionClient,
    input: CreateScheduledTermInput,
  ): Promise<ScheduledTermResult> {
    const parent = await tx.$queryRaw<Array<{ id: string; status: SubscriptionStatus }>>(Prisma.sql`
      SELECT "id", "status"::text AS "status"
      FROM "subscriptions"
      WHERE "id" = ${input.subscriptionId}
      FOR UPDATE
    `);
    if (parent.length !== 1) {
      throw new NotFoundException('Subscription not found');
    }
    if (parent[0]!.status === SubscriptionStatus.DELETED) {
      throw new ConflictException('Cannot schedule a term for a deleted subscription');
    }

    const latest = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: input.subscriptionId },
      orderBy: { generation: 'desc' },
      select: { generation: true },
    });
    const generation = (latest?.generation ?? 0) + 1;

    return tx.subscriptionTerm.create({
      data: {
        subscriptionId: input.subscriptionId,
        generation,
        planId: input.planId,
        planRevision: input.planRevision,
        planSnapshot: input.planSnapshot,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: SubscriptionTermStatus.SCHEDULED,
        baseTrafficLimitBytes: input.baseTrafficLimitBytes,
        baseDeviceLimit: input.baseDeviceLimit,
        trafficResetStrategy: input.trafficResetStrategy,
        resetAnchorAt: input.resetAnchorAt,
      },
      select: { id: true, generation: true, status: true },
    });
  }

  public async activateInTransaction(
    tx: Prisma.TransactionClient,
    termId: string,
    now = new Date(),
  ): Promise<TermActivationResult> {
    const rows = await tx.$queryRaw<LockedTerm[]>(Prisma.sql`
      SELECT
        st."id",
        st."subscription_id" AS "subscriptionId",
        s."status"::text AS "subscriptionStatus",
        st."status"::text AS "status",
        st."generation",
        st."starts_at" AS "startsAt"
      FROM "subscription_terms" AS st
      INNER JOIN "subscriptions" AS s ON s."id" = st."subscription_id"
      WHERE st."id" = ${termId}
      FOR UPDATE OF s, st
    `);
    const term = rows[0];
    if (term === undefined) {
      throw new NotFoundException('Subscription term not found');
    }
    if (term.subscriptionStatus === SubscriptionStatus.DELETED) {
      throw new ConflictException('Cannot activate a term for a deleted subscription');
    }
    if (term.status === SubscriptionTermStatus.ACTIVE) {
      return { id: term.id, status: term.status, changed: false };
    }
    if (term.status !== SubscriptionTermStatus.SCHEDULED) {
      throw new ConflictException(`Term ${term.id} is not scheduled for activation`);
    }

    const nextScheduled = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: term.subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      orderBy: [{ generation: 'asc' }, { id: 'asc' }],
      select: { id: true, generation: true, startsAt: true },
    });
    const active = await tx.subscriptionTerm.findFirst({
      where: { subscriptionId: term.subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      orderBy: { generation: 'desc' },
      select: { generation: true },
    });
    if (nextScheduled?.id !== term.id) {
      throw new ConflictException('Subscription term is not the next scheduled generation');
    }
    if (term.startsAt.getTime() > now.getTime()) {
      throw new ConflictException('Subscription term is not due for activation');
    }
    if (active !== null && term.generation <= active.generation) {
      throw new ConflictException('Subscription term generation is not newer than the active term');
    }

    await tx.subscriptionTerm.updateMany({
      where: {
        subscriptionId: term.subscriptionId,
        status: SubscriptionTermStatus.ACTIVE,
        id: { not: term.id },
      },
      data: { status: SubscriptionTermStatus.ENDED, endedAt: now },
    });

    const claimed = await tx.subscriptionTerm.updateMany({
      where: { id: term.id, status: SubscriptionTermStatus.SCHEDULED },
      data: { status: SubscriptionTermStatus.ACTIVE },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('Subscription term activation was superseded');
    }

    return { id: term.id, status: SubscriptionTermStatus.ACTIVE, changed: true };
  }

  public async closeForSubscriptionDeletion(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
  ): Promise<void> {
    const endedAt = new Date();
    await tx.subscriptionTerm.updateMany({
      where: { subscriptionId, status: SubscriptionTermStatus.ACTIVE },
      data: { status: SubscriptionTermStatus.ENDED, endedAt },
    });
    await tx.subscriptionTerm.updateMany({
      where: { subscriptionId, status: SubscriptionTermStatus.SCHEDULED },
      data: { status: SubscriptionTermStatus.CANCELED, endedAt },
    });
  }
}
