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
  /**
   * Traffic consumed so far, in GB (best-effort from the Remnawave
   * panel). `null` when the panel is unreachable, the subscription has
   * no upstream profile, or usage tracking is unavailable — the SPA
   * then hides the progress bar rather than showing a wrong value.
   */
  readonly trafficUsed: number | null;
  readonly deviceLimit: number;
  /** Remnawave profile UUID — the stable upstream identifier (not shown on the card). */
  readonly userRemnaId: string | null;
  /**
   * Human-readable Remnawave profile name (e.g. `rz_login_sub`) — this is
   * what the panels display and what the SPA shows on the card face instead
   * of the opaque UUID. `null` when the panel is unreachable or the
   * subscription has no upstream profile yet.
   */
  readonly profileName: string | null;
  /** Subscription/config URL from Remnawave — used by "Connect" button. */
  readonly url: string | null;
  /** Legacy alias for url (backwards compatibility with older SPA builds). */
  readonly configUrl: string | null;
  readonly startedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
