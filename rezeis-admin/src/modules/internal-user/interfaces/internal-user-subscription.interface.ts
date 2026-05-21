import { PlanType, SubscriptionStatus } from '@prisma/client';

interface InternalUserSubscriptionPlanInterface {
  readonly id: string | null;
  readonly name: string | null;
  readonly type: PlanType | null;
}

/**
 * Describes the current read-only subscription payload exposed to internal user clients.
 *
 * Used by reiwa SPA to render the subscription card (bank-card style):
 *   - plan.name → card title
 *   - userRemnaId → profile ID displayed on card face
 *   - url → "Connect" button copies this URL
 *   - expiresAt → expiry date on card
 *   - trafficLimit → traffic progress bar
 *   - deviceLimit → device count
 */
export interface InternalUserSubscriptionInterface {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly isTrial: boolean;
  readonly plan: InternalUserSubscriptionPlanInterface | null;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  /** Remnawave profile UUID — displayed as profile ID on the subscription card. */
  readonly userRemnaId: string | null;
  /** Subscription/config URL from Remnawave — used by "Connect" button. */
  readonly url: string | null;
  /** Legacy alias for url (backwards compatibility with older SPA builds). */
  readonly configUrl: string | null;
  readonly startedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
