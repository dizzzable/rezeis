import { PlanType, SubscriptionStatus } from '@prisma/client';

interface InternalUserSubscriptionPlanInterface {
  readonly name: string | null;
  readonly type: PlanType | null;
}

/**
 * Describes the current read-only subscription payload exposed to internal user clients.
 */
export interface InternalUserSubscriptionInterface {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly isTrial: boolean;
  readonly plan: InternalUserSubscriptionPlanInterface | null;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly configUrl: string | null;
  readonly startedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
