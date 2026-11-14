import { Prisma } from '@prisma/client';

import { AdminPlanInterface } from '../interfaces/admin-plan.interface';
import { readTrialSettings } from './trial-settings.util';

export const PLAN_INCLUDE = {
  durations: {
    include: {
      prices: {
        orderBy: {
          currency: 'asc',
        },
      },
    },
    orderBy: {
      days: 'asc',
    },
  },
} as const;

export type PlanRecord = Prisma.PlanGetPayload<{
  include: typeof PLAN_INCLUDE;
}>;

/**
 * What the PLAN EDITOR reads: the plan plus the one link it cannot infer from
 * the row itself — whether the plan is a bundle's face, and under which name
 * that bundle is listed in «Объединённые тарифы».
 *
 * Kept beside `PLAN_INCLUDE` rather than inside it: the catalogue and the
 * renewal quote select plans by the hundred and none of them read this, so an
 * every-reader include would add a join to paths that never look at it.
 */
export const ADMIN_PLAN_INCLUDE = {
  ...PLAN_INCLUDE,
  bundleFace: { select: { id: true, name: true } },
} as const;

export type AdminPlanRecord = PlanRecord & {
  /**
   * Optional deliberately: the plan editor calls `mapAdminPlan` on rows it read
   * with `PLAN_INCLUDE` alone, and an older response may not carry the relation
   * at all. Absence means "not a bundle's face".
   */
  readonly bundleFace?: { readonly id: string; readonly name: string } | null;
};

export function mapAdminPlan(plan: AdminPlanRecord): AdminPlanInterface {
  return {
    id: plan.id,
    orderIndex: plan.orderIndex,
    name: plan.name,
    description: plan.description,
    tag: plan.tag,
    icon: plan.icon,
    isActive: plan.isActive,
    isArchived: plan.isArchived,
    // Folded rather than passed through: a fixture or a response from an API
    // that predates the column reads as "visible", which is the only behaviour
    // that existed before it.
    hiddenFromBuyer: plan.hiddenFromBuyer === true,
    bundle:
      plan.bundleFace === undefined || plan.bundleFace === null
        ? null
        : { id: plan.bundleFace.id, name: plan.bundleFace.name },
    archivedRenewMode: plan.archivedRenewMode,
    type: plan.type,
    availability: plan.availability,
    trafficLimit: plan.trafficLimit,
    deviceLimit: plan.deviceLimit,
    trafficLimitStrategy: plan.trafficLimitStrategy,
    internalSquads: [...plan.internalSquads],
    externalSquad: plan.externalSquad,
    upgradeToPlanIds: [...plan.upgradeToPlanIds],
    replacementPlanIds: [...plan.replacementPlanIds],
    allowedUserIds: [...plan.allowedUserIds],
    trialSettings: readTrialSettings(plan.trialSettings),
    cashbackMode: plan.cashbackMode,
    cashbackPercent: plan.cashbackPercent,
    durations: plan.durations.map((duration) => ({
      id: duration.id,
      days: duration.days,
      isActive: duration.isActive,
      cashbackPoints: duration.cashbackPoints,
      prices: duration.prices.map((price) => ({
        id: price.id,
        currency: price.currency,
        price: price.price.toString(),
      })),
    })),
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}
