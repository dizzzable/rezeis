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

export function mapAdminPlan(plan: PlanRecord): AdminPlanInterface {
  return {
    id: plan.id,
    orderIndex: plan.orderIndex,
    name: plan.name,
    description: plan.description,
    tag: plan.tag,
    icon: plan.icon,
    isActive: plan.isActive,
    isArchived: plan.isArchived,
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
    durations: plan.durations.map((duration) => ({
      id: duration.id,
      days: duration.days,
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
