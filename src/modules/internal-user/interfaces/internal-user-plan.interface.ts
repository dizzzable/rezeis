import { Currency, PlanType } from '@prisma/client';

interface InternalUserPlanPriceInterface {
  readonly currency: Currency;
  readonly price: string;
}

interface InternalUserPlanDurationInterface {
  readonly id: string;
  readonly days: number;
  readonly prices: readonly InternalUserPlanPriceInterface[];
}

/**
 * Describes a read-only plan payload exposed to internal user clients.
 */
export interface InternalUserPlanInterface {
  readonly id: string;
  readonly orderIndex: number;
  readonly name: string;
  readonly description: string | null;
  readonly tag: string | null;
  readonly type: PlanType;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly durations: readonly InternalUserPlanDurationInterface[];
}
