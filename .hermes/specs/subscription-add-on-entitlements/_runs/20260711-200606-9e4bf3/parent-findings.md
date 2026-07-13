# Parent Research Notes

## Verified load-bearing findings

### P-001 — Current Add-on fulfillment has no entitlement lifecycle

`PaymentSubscriptionMutationService.applyAddOnTopUp()` directly increments `Subscription.trafficLimit` or `deviceLimit`, creates a profile sync job, and stamps `Transaction.fulfilledAt`. There is no separate entitlement/purchase row, activation boundary, expiry state or scheduled removal.

Evidence:
- `rezeis-admin/src/modules/payments/services/payment-subscription-mutation.service.ts:248-307`
- `rezeis-admin/prisma/schema.prisma:1158-1227,2432-2479`

### P-002 — Commercial baseline and current effective state are conflated

`Subscription.trafficLimit/deviceLimit` are initialized from plan values and sent as absolute Remnawave limits. Renewal replaces them with current plan limits; Add-on fulfillment increments the same columns. This means they cannot be safely treated as both immutable plan baseline and an aggregate including temporary effects.

Evidence:
- `rezeis-admin/prisma/schema.prisma:1158-1201`
- `rezeis-admin/src/modules/payments/services/payment-subscription-mutation.service.ts:174-188,267-283`
- `rezeis-admin/src/modules/profile-sync/profile-sync.processor.ts` and `test/profile-sync.processor.spec.ts`

### P-003 — Existing historical Add-ons cannot be safely backfilled as temporary

Historical `PurchaseType.ADDITIONAL` transactions snapshot type/value/target but not lifetime, activation or expiry. Current limits can also have been mutated by promotional/referral/admin paths. Therefore a migration cannot reliably subtract historical purchases or infer their intended end.

Evidence:
- `rezeis-admin/src/modules/payments/services/addon-purchase.service.ts:178-208`
- `rezeis-admin/prisma/schema.prisma:1322-1395`
- searches in referrals/promocodes services for direct traffic-limit increments/snapshot patching.

Parent recommendation: grandfather existing effective local limits as baseline at feature activation; create lifetime-managed ledger rows only for new checkout after rollout.

### P-004 — Remnawave contracts are stable where needed, with one HWID response drift

Both 2.7.4 and 2.8.0 use:

- `GET /api/users/{uuid}`
- `PATCH /api/users` with UUID in body
- `GET /api/hwid/devices/{userUuid}`
- `POST /api/hwid/devices/delete` with `{userUuid, hwid}`
- `{response: ...}` envelopes

Both expose `createdAt`, `updatedAt`, `lastTrafficResetAt`, absolute traffic/device limits and reset strategy. Neither exposes `nextTrafficResetAt`. Both contain `user.traffic_reset`.

HWID item drift:
- 2.7.4: required `userUuid`
- 2.8.0: required numeric `userId` plus `requestIp`
- stable normalized fields: `hwid`, `createdAt`, `updatedAt`, platform/model/user-agent fields.

Evidence:
- `icon/Remnawave API v274.json`
- `icon/Remnawave API v280.json`
- compact extractions `openapi-274.txt`, `openapi-280.txt` in this run directory.

### P-005 — Current HWID read fallback is unsafe for destructive automation

`getPanelUserDevices()` catches all errors and returns an empty set. Timeout, authentication failure and malformed response are indistinguishable from a true empty list. `deletePanelUserDevice()` also accepts missing response count as zero. Paid/destructive cleanup needs a strict adapter outcome and postcondition read-back.

Evidence:
- `rezeis-admin/src/modules/remnawave/services/remnawave-api.service.ts:515-565`

### P-006 — Vendor API does not define the next commercial reset boundary

OpenAPI has `lastTrafficResetAt` and strategies `NO_RESET|DAY|WEEK|MONTH|MONTH_ROLLING`, but no `nextTrafficResetAt`. Local comments claim `MONTH` is first-of-month UTC and `MONTH_ROLLING` profile-creation anniversary, but the supplied OpenAPI does not document the exact calendar formula for all strategies. Early/manual reset must preserve entitlement by accepted product decision.

Evidence:
- compact OpenAPI extractions: `nextTrafficResetAt count=0`
- `rezeis-admin/src/modules/plans/dto/traffic-limit-strategy.dto.ts:3-14`

Parent recommendation: Rezeis owns a snapshotted local cycle epoch/boundary; webhook is an acceleration/reconciliation signal, never sole expiry proof. `NO_RESET + UNTIL_NEXT_RESET` must be rejected as inapplicable unless a concrete local planned boundary exists.

### P-007 — Unlimited eligibility needs fail-closed backend and UX handling

Traffic unlimited is `trafficLimit === null`; device unlimited is local `deviceLimit < 0` and maps to Remnawave `0`. Current Add-on checkout rejects unlimited traffic but does not select/check `deviceLimit`, while fulfillment increments it. For `-1`, an Add-on can corrupt unlimited into a finite/arithmetic value.

Evidence:
- `rezeis-admin/src/modules/payments/services/addon-purchase.service.ts:120-160`
- `rezeis-admin/src/modules/payments/services/payment-subscription-mutation.service.ts:267-283`
- `rezeis-admin/src/modules/profile-sync/profile-sync.processor.ts:329-342`
- `reiwa/web/src/features/addons/addons-page.tsx:157-180` hides only unlimited traffic.

### P-008 — Renewal integration requires full line-item snapshot and fingerprint

Current renewal checkout contains only renewal subscription items. Pending-draft reuse compares user/gateway/channel/currency/amount and exact subscription set, not selected plan/duration content. When Add-ons join renewal, a canonical full checkout fingerprint must include each subscription's plan, duration and selected Add-on IDs/quantities/lifetime snapshots, or a same-total draft may be reused incorrectly.

Evidence:
- `rezeis-admin/src/modules/payments/services/payments-renewal-checkout.service.ts:27-39,168-243`
- `rezeis-admin/prisma/schema.prisma:1370-1395`
- `reiwa/src/api/routes/payments.ts:120-226`
- `reiwa/web/src/features/renewal/renewal-page.tsx`

### P-009 — Early renewal needs scheduled Add-on activation

Current renewal extends from `max(now, current expiresAt)`. Therefore an Add-on selected for a future renewal term must snapshot that future term start and remain scheduled until it begins, rather than become active immediately or use up its lifetime before renewal begins.

Evidence:
- `rezeis-admin/src/modules/payments/services/payment-subscription-mutation.service.ts:155-188`
- `test/payment-combined-renewal.service.spec.ts`

### P-010 — Sync convergence is incomplete for paid UPDATE failures

Profile-sync jobs are durable and PENDING jobs are swept, but failed CREATE jobs alone are auto-recovered. Failed UPDATE/DELETE jobs are explicitly left for a later real mutation. A paid Add-on or expiry projection UPDATE can therefore remain unapplied without automatic convergence. Absolute writes also need per-subscription monotonic desired revision/coalescing to prevent an older job completing last.

Evidence:
- `rezeis-admin/src/modules/profile-sync/profile-sync-queue.service.ts:66-135`
- `rezeis-admin/src/modules/profile-sync/profile-sync.processor.ts`

### P-011 — Subscription deletion and expiry must terminate pending/active entitlements deterministically

Self-service deletion marks subscription DELETED and schedules panel profile removal. Expired profile cleanup can delete profile after grace. Entitlements need terminal state/cancellation semantics and must not trigger redundant destructive HWID cleanup after whole-profile deletion.

Evidence:
- `rezeis-admin/src/modules/subscriptions/services/subscription-deletion.service.ts`
- `rezeis-admin/src/modules/profile-sync/expired-profile-cleanup.service.ts`

### P-012 — Refund/chargeback automatic clawback is not supported by current payment state machine

Provider refunds normalize to `TransactionStatus.CANCELED`, but reconciliation treats an already COMPLETED transaction as final and returns before processing later refund events. Automatic Add-on revocation on refund would require a separate payment-state redesign.

Evidence:
- `rezeis-admin/src/modules/payments/services/payment-reconciliation.service.ts:46-60,271-297`
- gateway normalizers/adapters expose `REFUNDED`/chargeback states.

Parent recommendation for v1: refund/chargeback after fulfillment creates an operator alert/audit action and does not auto-clawback; automatic reversal is explicitly out of scope.

### P-013 — Contract/UI test coverage for Add-ons is currently thin

Admin web has an Add-ons page test, but targeted backend Add-on lifecycle/payment tests and Reiwa Add-ons/renewal UI tests were not found under expected test paths. Existing focused tests cover combined renewal, profile sync, Remnawave API and access-mode behavior.

Evidence:
- `rezeis-admin/web/src/features/add-ons/add-ons-page.test.tsx`
- `rezeis-admin/test/payment-combined-renewal.service.spec.ts`
- `rezeis-admin/test/profile-sync*.spec.ts`
- `rezeis-admin/test/remnawave-api.service.spec.ts`
- targeted searches in `reiwa/test` and `reiwa/web/src`.

## Pending swarm validation

- exact recommended schema/state machine and concurrency controls;
- cross-repo contract inventory and `rezeis-subpage` dependency check;
- adversarial severity classification and missing acceptance criteria;
- any evidence contradicting the parent migration/refund/reset assumptions.
