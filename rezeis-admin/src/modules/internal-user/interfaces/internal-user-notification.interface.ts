/**
 * Single user-facing notification event (created by admin tooling, the
 * auto-renew job, partners service, etc.). Reiwa renders these in the
 * dashboard's notifications panel and on the bot's `Activity` feed.
 */
export interface InternalUserNotificationInterface {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly readAt: string | null;
  readonly createdAt: string;
}

/**
 * Single transaction (payment / subscription purchase / partner payout)
 * exposed to reiwa. Currency / amount are returned as strings to keep
 * decimal precision identical to what the upstream Prisma `Decimal` carries.
 */
export interface InternalUserTransactionInterface {
  readonly id: string;
  readonly paymentId: string;
  readonly status: string;
  readonly purchaseType: string;
  readonly channel: string;
  readonly gatewayType: string;
  readonly currency: string;
  readonly amount: string;
  /**
   * Human-readable title for the transaction, derived from `planSnapshot`:
   * the add-on receipt name (add-on top-ups) or the plan name (plan
   * purchases). `null` when neither is present — the client then falls back to
   * a purchase-type / gateway label. Fixes add-on transactions rendering as a
   * bare gateway name.
   */
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * User-safe view of a durable add-on entitlement, shown in the cabinet's
 * "My add-ons" history. Internal machinery (correlation ids, version,
 * epoch/term ids, terminal reasons) is intentionally excluded.
 */
export interface InternalUserAddOnEntitlementInterface {
  readonly id: string;
  readonly subscriptionId: string;
  readonly receiptName: string;
  readonly type: string;
  readonly valuePerUnit: number;
  readonly quantity: number;
  readonly lifetime: string;
  readonly state: string;
  readonly currency: string;
  readonly totalAmount: string;
  readonly purchasedAt: string;
  readonly activatedAt: string | null;
  readonly expiresAt: string | null;
}
