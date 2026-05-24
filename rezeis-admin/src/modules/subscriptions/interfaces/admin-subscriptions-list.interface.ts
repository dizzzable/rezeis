/**
 * Shape returned by `GET /admin/subscriptions` and consumed directly by
 * the admin SPA at `web/src/features/subscriptions/subscriptions-page.tsx`.
 *
 * Notes:
 *   - `expireAt` (legacy alias) and `expiresAt` are both populated so we
 *     don't break the existing client while we migrate it.
 *   - `plan.name` is hydrated from `Subscription.planSnapshot.name`. The
 *     subscription has no relational `plan_id`; the historical plan is
 *     embedded as JSON snapshot at purchase time.
 */
export interface AdminSubscriptionListItemInterface {
  readonly id: string;
  readonly status: string;
  readonly isTrial: boolean;
  readonly trafficLimit: number | null;
  readonly deviceLimit: number;
  readonly expireAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly user: {
    readonly id: string;
    readonly name: string | null;
  } | null;
  readonly userTelegramId: string | null;
  readonly plan: {
    readonly name: string | null;
  } | null;
}

export interface AdminSubscriptionsListInterface {
  readonly items: readonly AdminSubscriptionListItemInterface[];
  readonly total: number;
}

export interface AdminSubscriptionStatsInterface {
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly trialCount: number;
  readonly expiringIn7d: number;
  readonly generatedAt: string;
}
