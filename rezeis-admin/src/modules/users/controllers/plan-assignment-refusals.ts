/**
 * THE MACHINE-READABLE HALF of «Назначить план»'s own refusals
 * (`PATCH /admin/users/subscriptions/:subscriptionId` with `planId`).
 *
 * The server keeps writing an English sentence and adds a code beside it; the
 * SPA owns the operator's language and branches on the code
 * (`web/src/features/users/plan-assignment-refusals.ts`). A thrown code
 * survives `AdminSafeExceptionFilter` only when it is listed in
 * `SAFE_PRODUCT_CODES`; stripped, the operator read the English sentence.
 *
 * A module of its own with no imports, like `subscription-sync-refusals.ts`
 * next door and for the same reason: the SPA's test imports this file across
 * the package boundary and fails by name when a code here is renamed without
 * the SPA's hand-written copy following (nothing the production frontend
 * compiles may reach the backend tree — `build-isolation.test.ts`).
 */
export const PLAN_ASSIGNMENT_REFUSAL_CODES = {
  /**
   * A paid renewal period is queued and carries add-ons bought for it:
   * rotating the subscription onto the plan now would cancel that period, so
   * nothing was changed (409).
   */
  queuedRenewalWithAddOns: 'PLAN_ASSIGNMENT_BLOCKED_BY_QUEUED_RENEWAL',
} as const;
