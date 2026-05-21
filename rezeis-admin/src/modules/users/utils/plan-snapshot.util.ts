import { Prisma } from '@prisma/client';

/**
 * Plan row shape required to build a snapshot. Subset of `Plan` model so
 * we can call this from any controller/service without coupling to a
 * specific Prisma include.
 */
export interface PlanSnapshotInput {
  readonly id: string;
  readonly name: string;
  readonly tag: string | null;
  readonly type: string;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly trafficLimitStrategy: string;
  readonly internalSquads: readonly string[];
  readonly externalSquad: string | null;
}

/**
 * Builds the canonical `planSnapshot` JSON blob stored on `Subscription`.
 *
 * Mirrors the shape produced by `give-subscription` and the payment-side
 * mutation services so all subscription rows look identical regardless of
 * how they were created.
 */
export function buildPlanSnapshot(plan: PlanSnapshotInput): Prisma.InputJsonValue {
  return {
    id: plan.id,
    name: plan.name,
    tag: plan.tag,
    type: plan.type,
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    trafficLimitStrategy: plan.trafficLimitStrategy,
    internalSquads: Array.isArray(plan.internalSquads) ? [...plan.internalSquads] : [],
    externalSquad: plan.externalSquad ?? null,
  } as unknown as Prisma.InputJsonValue;
}
