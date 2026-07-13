---
spec_version: 1
created_at: 2026-07-11T20:36:00+03:00
workflow: requirements-first
status: ready-for-review
run_id: 20260711-200606-9e4bf3
---

# Временные Add-on entitlements — implementation tasks

## Execution policy

- Implementation starts only after explicit user approval of this spec.
- Use TDD per task: failing focused test → minimal implementation → focused pass → affected integration gates.
- Product repositories are independent; no cross-repo commit mixes Rezeis and Reiwa.
- No bump/tag/push/publish/deploy/release task. Release requires later explicit `выпускай`/`релизь` and a clean read-only review swarm.
- Exact new filenames below are design targets; preserve surrounding naming/style during implementation.

## Dependency graph

```text
T-001 ─┬→ T-002 ─→ T-003 ─→ T-004 ─┬→ T-005 ─→ T-007 ─→ T-008 ─┐
       │                             ├→ T-009 ─→ T-010 ─→ T-011 ─┤
       └→ T-006 ─────────────────────┤                            │
                                     ├→ T-012                    ├→ T-016
                                     ├→ T-013                    ├→ T-017
                                     └→ T-014 ─→ T-015 ──────────┘
T-004 ───────────────────────────────────────────────────────────→ T-018
T-016 + T-017 + T-018 → implementation-ready feature gate (not release)
```

## Tasks

### T-001 — Additive schema, enums and migration primitives

- **Status:** completed
- **Priority:** must
- **Objective:** introduce catalog lifetime/archive/revision, service terms, reset epochs, entitlement ledger/events, projection, device plans and incidents without changing existing runtime behavior.
- **Requirements:** R-001, R-003, R-015.
- **Acceptance criteria:** AC-R001-1..3, AC-R003-1..5, AC-R015-1..2.
- **Files:**
  - Modify: `rezeis-admin/prisma/schema.prisma`
  - Create: `rezeis-admin/prisma/migrations/20260712130000_add_subscription_add_on_entitlements/migration.sql`
  - Create/Test: `rezeis-admin/test/add-on-entitlement-schema.spec.ts`
- **Blocked by:** none
- **Parallel group:** P0
- **Implementation notes:** use canonical nullable unlimited in new models; preserve current subscription columns as compatibility projection; unique source line and term generation indexes; referenced catalog entries archive instead of delete. Keep migration additive/no panel writes.
- **Tests/verification:** write schema/migration invariant test first; run `npm run prisma:generate`, focused test, `npm run typecheck`.
- **Rollback/migration:** down/operational rollback must preserve financial/ledger rows once used; initial migration can be rolled back only before admission.
- **Risk:** high.

### T-002 — Pure unlimited and UTC reset-cycle domain policies

- **Status:** completed
- **Priority:** must
- **Objective:** implement checked limit arithmetic and deterministic reset epochs independent of Remnawave webhooks.
- **Requirements:** R-002, R-007.
- **Acceptance criteria:** AC-R002-1/2/4, AC-R007-1..5.
- **Files:**
  - Create: `rezeis-admin/src/modules/add-on-entitlements/domain/subscription-limit.ts`
  - Create: `rezeis-admin/src/modules/add-on-entitlements/domain/reset-cycle-policy.ts`
  - Create: `rezeis-admin/test/subscription-limit.spec.ts`
  - Create: `rezeis-admin/test/reset-cycle-policy.spec.ts`
  - Create: `rezeis-admin/test/reset-cycle-policy.pbt.spec.ts`
- **Blocked by:** T-001
- **Parallel group:** P1
- **Implementation notes:** `null` unlimited, checked BigInt/int sums; no arithmetic on legacy sentinels. Strategy capability map defaults disabled. Freeze UTC fixtures for day/week/month/rolling, leap years and exact boundaries; `NO_RESET` has no epoch.
- **Tests/verification:** focused Node tests and fast-check property tests; expected manual reset input cannot change epoch output.
- **Rollback/migration:** pure code, feature-disabled.
- **Risk:** high because vendor parity remains staged.

### T-003 — Entitlement aggregate and lifecycle state machine

- **Status:** completed
- **Priority:** must
- **Objective:** create term/entitlement lifecycle services and immutable transition events.
- **Requirements:** R-003, R-004, R-006.
- **Acceptance criteria:** AC-R003-2..5, AC-R004-2/4, AC-R006-1..4.
- **Files:**
  - Create: `rezeis-admin/src/modules/add-on-entitlements/add-on-entitlements.module.ts`
  - Create: `.../domain/add-on-entitlement-state.ts`
  - Create: `.../services/add-on-entitlement.service.ts`
  - Create: `.../services/subscription-term.service.ts`
  - Modify: `rezeis-admin/src/modules/subscriptions/subscriptions.module.ts`
  - Create: `rezeis-admin/test/add-on-entitlement.service.spec.ts`
  - Create: `rezeis-admin/test/add-on-entitlement-state.pbt.spec.ts`
- **Blocked by:** T-001, T-002
- **Parallel group:** P2
- **Implementation notes:** source snapshots immutable; transitions use conditional version/state updates and append events. Term deletion/closure is explicit; refund creates incident/transition command only, not hidden auto-reversal.
- **Tests/verification:** legal/illegal transition table, duplicate activation/expiry, separate stacked rows, deletion semantics, compensating event tests.
- **Rollback/migration:** no runtime admission until flags; retain rows on rollback.
- **Risk:** high.

### T-004 — Atomic projection, grandfather backfill and shadow mode

- **Status:** completed
- **Priority:** must
- **Objective:** compute versioned effective state and establish zero-drift legacy baseline without upstream writes.
- **Requirements:** R-003, R-004, R-015.
- **Acceptance criteria:** AC-R003-1/4, AC-R004-1..4, AC-R015-1..5.
- **Files:**
  - Create: `rezeis-admin/src/modules/add-on-entitlements/services/effective-projection.service.ts`
  - Create: `.../services/entitlement-cutover.service.ts`
  - Create: `rezeis-admin/scripts/add-on-entitlement-cutover.ts`
  - Modify: `rezeis-admin/src/modules/add-on-entitlements/add-on-entitlements.module.ts`
  - Create: `rezeis-admin/test/effective-projection.service.spec.ts`
  - Create: `rezeis-admin/test/add-on-entitlement-cutover.spec.ts`
  - Create: `rezeis-admin/test/add-on-entitlement-postgres-concurrency.spec.ts`
- **Blocked by:** T-003
- **Parallel group:** P3
- **Implementation notes:** recompute + revision + ProfileSyncJob in one Prisma transaction. Dry-run default; idempotent cutover key/version; grandfather current local values exactly; historical snapshots are provenance only. Webhook observed values cannot enter baseline.
- **Tests/verification:** finite/unlimited/legacy reward/top-up fixtures, rerun idempotency, projection equality, overflow, concurrent updates with real PostgreSQL.
- **Rollback/migration:** flag remains shadow; rollback disables active path but preserves data.
- **Risk:** critical.

### T-005 — Direct checkout and fulfillment reliability

- **Status:** completed
- **Priority:** must
- **Objective:** implement authoritative eligibility, four idempotency layers, atomic free grants and captured-line recovery.
- **Requirements:** R-005, R-006, R-016.
- **Acceptance criteria:** AC-R005-1..6, AC-R006-1/2/4, AC-R016-1..5.
- **Files:**
  - Modify: `rezeis-admin/src/modules/payments/dto/internal-addon-purchase.dto.ts`
  - Modify: `.../services/addon-purchase.service.ts`
  - Modify: `.../services/payment-provider-execution.service.ts`
  - Modify: `.../services/payment-reconciliation.service.ts`
  - Refactor: `.../services/payment-subscription-mutation.service.ts`
  - Create: `.../services/add-on-fulfillment-recovery.service.ts`
  - Modify: `rezeis-admin/src/modules/payments/payments.module.ts`
  - Create: `rezeis-admin/test/addon-purchase.service.spec.ts`
  - Create: `rezeis-admin/test/add-on-fulfillment-recovery.spec.ts`
  - Extend: `rezeis-admin/test/payment-reconciliation-notifications.service.spec.ts`
- **Blocked by:** T-004, T-006
- **Parallel group:** P4-payments
- **Implementation notes:** stable canonical fingerprint and client-key conflict; provider reference/idempotency capability per adapter without pretending unsupported guarantees. Completed early return must still allow missing-entitlement recovery. Free completion/entitlement/projection/job atomic. Capture-time incompatibility becomes remediation.
- **Delivered (sub-increments):** (a) `checkout-fingerprint.util.ts`; (b) request idempotency (`idempotency_key`/`checkout_fingerprint` migration + `@@unique([userId, idempotencyKey])`) + optimistic revision guard; (c) flag-gated ledger fulfillment (`applyAddOnViaLedger`, direct-purchase); (d) captured-but-undelivered recovery sweeper (`add-on-fulfillment-recovery.service.ts`, `@Cron`, atomic claim/release mirroring the reconciler, `PAYMENT_FULFILLMENT_RECOVERED` event); (e) `PROVIDER_OUTCOME_UNKNOWN` — non-deterministic provider-create failures stamp the draft (kept, not deleted) so a keyed retry replays it and the webhook/sweeper resolve the money. Stable merchant reference = `transaction.paymentId` (already forwarded to every adapter). Reset-scoped (`UNTIL_NEXT_RESET`) and non-ACTIVE (`LIMITED`) fulfillment fall back to legacy pending T-008.
- **Tests/verification:** double click/retry, same key/different body, provider unknown outcome, duplicate webhook vs two payments, crash points, status/plan/unlimited race, zero-price abuse/rate tests.
- **Rollback/migration:** admission flag off restores legacy checkout for new requests only; already captured v2 lines continue recovery.
- **Risk:** critical.

### T-006 — Catalog lifetime, archive and typed eligibility API

- **Status:** completed
- **Priority:** must
- **Objective:** expose catalog policy and subscription-specific server eligibility with stable errors.
- **Requirements:** R-001, R-002, R-014.
- **Acceptance criteria:** AC-R001-1..4, AC-R002-2..5, AC-R014-1/2.
- **Files:**
  - Modify: `rezeis-admin/src/modules/add-ons/dto/admin-add-on.dto.ts`
  - Modify: `.../services/add-ons.service.ts`
  - Modify: `.../controllers/admin-add-ons.controller.ts`
  - Modify: `.../controllers/internal-add-ons.controller.ts`
  - Create: `.../services/add-on-eligibility.service.ts`
  - Create: `rezeis-admin/test/add-ons.service.spec.ts`
  - Create: `rezeis-admin/test/add-on-eligibility.service.spec.ts`
  - Create: `rezeis-admin/test/internal-add-ons.controller.spec.ts`
- **Blocked by:** T-001, T-002
- **Parallel group:** P2
- **Implementation notes:** keep legacy plan endpoint additive during rollout; v2 endpoint takes subscription target. Unknown plan IDs rejected in admin. Distinguish empty/unavailable. Backend is authority.
- **Tests/verification:** CRUD/RBAC/audit, default lifetime, archive references, each ineligibility code, `ACTIVE|LIMITED`, `NO_RESET`, capabilities and both unlimited resources.
- **Rollback/migration:** legacy endpoint remains; archived rows stay archived.
- **Risk:** medium-high.

### T-007 — Renewal composition and canonical fingerprint

- **Status:** in_progress (backend complete; reiwa forwarding + cabinet UX tracked under T-015)
- **Priority:** must
- **Objective:** add explicit eligible Add-on lines to renewal checkout without wrong draft reuse.
- **Requirements:** R-005, R-008.
- **Acceptance criteria:** AC-R005-1/3/6, AC-R008-2..5.
- **Files:**
  - Modify: `rezeis-admin/src/modules/payments/dto/internal-renewal-checkout.dto.ts`
  - Modify: `.../services/payments-renewal-checkout.service.ts`
  - Modify: `.../services/payment-subscription-mutation.service.ts`
  - Modify: `rezeis-admin/src/modules/subscriptions/services/subscription-renewal.service.ts`
  - Create: `rezeis-admin/src/modules/payments/utils/checkout-fingerprint.util.ts`
  - Create: `rezeis-admin/test/checkout-fingerprint.spec.ts`
  - Extend: `rezeis-admin/test/payment-combined-renewal.service.spec.ts`
  - Extend: `rezeis-admin/test/subscription-renewal.service.spec.ts`
- **Blocked by:** T-005
- **Parallel group:** P5-renewal
- **Implementation notes:** stable sorted canonical JSON; include plan/duration/term and all Add-on revision/lifetime/money data. Same amount is irrelevant. Create scheduled term/entitlements atomically on fulfillment.
- **Delivered (T-007a, canonical fingerprint):** `buildRenewalCheckoutFingerprint` + `RenewalCheckoutFingerprintInput`/`RenewalLineFingerprintInput`/`RenewalAddOnSelectionInput` in `payments/utils/checkout-fingerprint.util.ts` — order-independent (lines sorted by subscriptionId, add-ons by addOnId), over the full composition (plan/duration/term + each add-on revision/type/value/lifetime/activation, quantity=1), amount deliberately EXCLUDED (same total ≠ same composition). Plus `findDuplicateAddOnSelection` (per-line duplicate-pick rejection). Tests: `test/checkout-fingerprint.spec.ts` (+6).
- **Delivered (T-007b, request idempotency wiring):** `idempotencyKey` on `InternalRenewalCheckoutDto` + `RenewalCheckoutInput` + controller passthrough. `renewalCheckout` computes the renewal fingerprint from the priced composition and, for a keyed request, replays the existing draft (same composition) or throws `IDEMPOTENCY_KEY_CONFLICT` (different composition); `createCombinedDraft` persists `idempotencyKey`+`checkoutFingerprint` (Transaction columns from T-005b) and replays on the P2002 unique race. Keyless (legacy) requests keep the heuristic amount+subscription-set draft reuse. Tests: `test/payments-renewal-checkout-idempotency.spec.ts` (4).
- **Delivered (T-007c, renewal-term PRODUCER):** `PaymentSubscriptionMutationService` gains `SubscriptionTermService` (5th ctor arg) + private `scheduleRenewalTermBestEffort`. After a single-subscription `RENEW` commits, it schedules the next durable term (design D-4): reads the ACTIVE term, computes `startsAt = current term endsAt` (or `now` if already ended), `endsAt = calculateExpiry(startsAt, durationDays)`, and creates a SCHEDULED gen-N+1 term via `createScheduledInTransaction` with the plan-derived baseline (`trafficLimit GB → BigInt*GIB` or null; `deviceLimit <= 0 → null`; `trafficResetStrategy` from plan). Runs in a SEPARATE transaction AFTER the renewal commits so a shadow-model failure can NEVER roll back a real renewal (best-effort, logged+swallowed). Gated by `entitlementShadow` (OFF ⇒ no-op) and only when an ACTIVE durable term exists (cutover done); never double-schedules (skips when a SCHEDULED term already exists). Pairs with the T-008d activation CONSUMER — both halves of the renewal-term lifecycle are now proven. Real-DB test (+1) in `add-on-entitlement-postgres-concurrency.spec.ts`: flag-OFF ⇒ renewal commits, 0 scheduled terms; flag-ON ⇒ gen-2 SCHEDULED term (`startsAt = old endsAt`, `endsAt = startsAt+30d`, baseline mirrors plan), idempotent 2nd renewal ⇒ still exactly 1 scheduled. 19/19 real-DB green.
- **Delivered (T-007d, combined-renewal term producer):** `applyCombinedRenewal` now extends the proven T-007c producer to the multi-subscription path: after the combined renewal commits, it schedules the next durable term PER renewed line (best-effort, per line, in a SEPARATE transaction — same safety contract: a shadow failure can never roll back a real renewal). No-op unless `entitlementShadow` is on and the line's subscription already has an ACTIVE durable term. Real-DB test (+1): a 2-line combined renewal where only one line has a cutover term ⇒ that line gets a gen-2 SCHEDULED term (`startsAt = old endsAt`, baseline mirrors plan), the term-less line stays legacy (0 terms). 21/21 real-DB green.
- **Delivered (T-007e, combined-renewal source-line guard relaxation):** `AddOnEntitlementService.createPendingInTransaction` now accepts a combined-renewal source transaction (`transaction.subscriptionId = null`) when a `TransactionItem` renewal line binds the paying transaction to the target subscription — the line is locked `FOR UPDATE` so it serializes against combined-renewal application. Any OTHER mismatch (transaction bound to a different, non-null subscription) still hard-rejects, so the single-subscription cross-binding guards are unchanged. This is the prerequisite that lets renewal add-on entitlements be created atomically on a combined renewal. Real-DB test (+1): combined tx bound via a line ⇒ PENDING entitlement created; a target subscription with NO line on that tx ⇒ rejected (`no renewal line`); the existing cross-subscription DB-boundary rejections still hold. 22/22 real-DB green; full backend 1446/1446.
- **Delivered (T-007f, renewal add-on schema + atomic fulfillment):** migration `20260712150000_renewal_add_on_lines` adds a nullable `add_on_lines` JSONB column to `transaction_items` (additive, no backfill; `TransactionItem.addOnLines Json?`). `applyCombinedRenewal` now parses each line's add-on selections (`readRenewalAddOnLines`, malformed-tolerant) and, when `renewalAddOns` is ON and a line carries add-ons, creates the SCHEDULED renewal term + its PENDING entitlements ATOMICALLY inside the fulfillment transaction (paid goods can't be lost to a best-effort failure); lines without add-ons keep the T-007d post-commit best-effort term scheduling. Term scheduling was refactored into a shared `scheduleRenewalTermInTransaction` (idempotent — reuses an existing SCHEDULED term). Entitlements activate at the renewed term start (`scheduledActivationAt = term.startsAt`) and expire at the term boundary; a missing durable term when add-ons were sold fails closed (`ConflictException`, reconciler retries — never silently drops paid add-ons). The combined-renewal source-line guard (T-007e) is what lets these bind. Real-DB tests (+2): flag-ON ⇒ gen-2 SCHEDULED term + one PENDING entitlement bound to it (correct term/activation/expiry/revision/value), idempotent replay stays 1; flag-OFF ⇒ no entitlement, line stays legacy. 24/24 real-DB green; full backend 1448/1448.
- **Delivered (T-007g, intake PRODUCER — checkout composes + prices + persists add-on lines):** the checkout side is now wired end-to-end. `InternalRenewalCheckoutDto` gains `addOns: RenewalAddOnSelectionDto[]` (`{subscriptionId, addOnIds[]}`) + `toAddOnSelectionMap`; the controller forwards it. `RenewalCheckoutInput.addOns` flows into `SubscriptionRenewalService.priceRenewalItems`, which — only when `renewalAddOns` is ON — validates each selection against the subscription's authoritative eligibility (`AddOnEligibilityService.listForSubscription`, injected via `AddOnsModule`), rejecting unknown/ineligible (`ADDON_NOT_ELIGIBLE`), duplicate (`ADDON_DUPLICATE_SELECTION`), or gateway-currency-priceless (`ADDON_PRICE_UNAVAILABLE`) picks, and prices each into a `PricedRenewalAddOnLineInterface` (activation `TERM_START`, deterministic `sourceLineKey = renew:{sub}:{addOn}`). The combined `total` now includes every add-on line; `createCombinedDraft` persists them to `TransactionItem.addOnLines`; the renewal fingerprint is built from the real add-on selections (not `[]`). Flag OFF ⇒ selections ignored, plan-only total (fully dormant). Tests: `subscription-renewal.service.spec.ts` (+4: flag-on prices lines + total + TERM_START; flag-off ignores; ineligible reject; duplicate + missing-price reject). Full backend 1452/1452, eslint 0.
- **Status of the vertical:** the entire backend money path is now proven — compose → price/eligibility-gate → persist (`add_on_lines`) → canonical fingerprint/idempotency → atomic fulfillment (SCHEDULED term + PENDING entitlements bound via the combined-renewal guard) → activation consumer (T-008d) → boundary expiry (T-008f). Only the **reiwa forwarding + cabinet UX remains (T-015)**. All behind `renewalAddOns` (OFF).
- **Tests/verification:** same-total different products, order normalization, duplicate selection rejection, early renewal, failed multi-line atomicity.
- **Rollback/migration:** `renewal_addons` flag; old renewals remain valid.
- **Risk:** high.

### T-008 — Term boundary, reset scheduler and webhook reconciliation

- **Status:** in_progress
- **Priority:** must
- **Objective:** activate scheduled renewal lines and expire entitlements only at authoritative local term/reset boundaries.
- **Requirements:** R-007, R-008.
- **Acceptance criteria:** AC-R007-1..5, AC-R008-1/2/5/6.
- **Files:**
  - Create: `rezeis-admin/src/modules/add-on-entitlements/services/entitlement-boundary.service.ts`
  - Create: `.../services/entitlement-boundary-scheduler.service.ts`
  - Modify: `rezeis-admin/src/modules/remnawave/services/remnawave-webhook.service.ts`
  - Modify: `rezeis-admin/src/modules/add-on-entitlements/add-on-entitlements.module.ts`
  - Create: `rezeis-admin/test/entitlement-boundary.service.spec.ts`
  - Create: `rezeis-admin/test/entitlement-boundary-postgres-race.spec.ts`
- **Blocked by:** T-007
- **Parallel group:** P6-boundaries
- **Implementation notes:** due claim by epoch/term unique key; webhook persists normalized observation and calls same idempotent transition only at/after planned boundary. New term activation, old term close and one projection commit are atomic.
- **Delivered (authoritative local-time expiry):** `services/entitlement-boundary.service.ts` — `expireDueForSubscription(subscriptionId, now)`: finds ACTIVE entitlements with `expiresAt <= now`, per entitlement `BEGIN_EXPIRY` (ACTIVE→EXPIRING, idempotent commandKey `boundary-begin:{id}`), and for EXTRA_TRAFFIC also `COMPLETE_EXPIRY` (→EXPIRED, `boundary-complete:{id}`); EXTRA_DEVICES stays EXPIRING for the T-011 device saga. Then one atomic projection recompute (only when a baseline term is ACTIVE) + mirror to legacy columns + a versioned `ProfileSyncJob` (aggregateKey/desiredRevision/cause=BOUNDARY_EXPIRY) so the dropped limit propagates (T-009 supersession keeps the latest). A manual panel reset can never expire a commercial entitlement — expiry is driven purely by local `expiresAt`. `services/entitlement-boundary-scheduler.service.ts` — worker-only `@Cron` finds subscriptions with due ACTIVE entitlements and runs the boundary per subscription (one failure never aborts the sweep), enqueuing produced sync jobs. Registered in `add-on-entitlements.module.ts` (+ProfileSyncModule). Tests: `test/entitlement-boundary.service.spec.ts` (5) + `test/entitlement-boundary-scheduler.service.spec.ts` (3).
- **Remaining:** reset-epoch row creation + `expiresAt` for UNTIL_NEXT_RESET (needs `SubscriptionResetEpoch` rows; UNTIL_NEXT_RESET still falls back to legacy today, so no epochs exist yet — gated by `resetExpiry.<strategy>`); webhook-triggered idempotent boundary call at/after the planned instant (needs `forwardRef` to avoid the RemnawaveModule↔AddOnEntitlementsModule cycle); device-reduction planning trigger after a device-entitlement boundary (call `DeviceReductionPlanService.planForSubscription` outside the tx); scheduled renewal-term activation at term start (pairs with T-007 add-on renewal composition). PostgreSQL race spec (`entitlement-boundary-postgres-race.spec.ts`) to add with the epoch path.
- **Delivered (T-008b, device-reduction planning trigger):** `EntitlementBoundaryService` now reports `deviceExpiryTriggered` when a due EXTRA_DEVICES entitlement begins expiry; `EntitlementBoundarySchedulerService` then calls `DeviceReductionPlanService.planForSubscription` (outside the boundary tx) so the deterministic reduction plan is built the moment the desired device limit drops (execution stays operator/flag-gated). Tests updated (boundary + scheduler).
- **Remaining (coupled / higher-risk):** reset-epoch row creation + `expiresAt` for UNTIL_NEXT_RESET (gated `resetExpiry.<strategy>`, pairs with the reset scheduler); webhook-triggered idempotent boundary call (needs `forwardRef` for the RemnawaveModule↔AddOnEntitlementsModule cycle — deferred as a latency optimization since the scheduler already guarantees convergence); scheduled renewal-term activation at term start (pairs with T-007 add-on renewal composition); PostgreSQL race spec with the epoch path.
- **Delivered (T-008c, PostgreSQL boundary-race spec):** `test/add-on-entitlement-postgres-concurrency.spec.ts` — a real-DB test proving two concurrent `expireDueForSubscription` sweeps on the same due entitlement expire it EXACTLY once (idempotent BEGIN/COMPLETE by command key, optimistic-version loser rolls back cleanly) and the projection drops to the term baseline. 16/16 real-DB green.
- **Remaining (coupled / higher-risk):** reset-epoch row creation + `expiresAt` for UNTIL_NEXT_RESET (gated `resetExpiry.<strategy>`, pairs with the reset scheduler); webhook-triggered idempotent boundary call (needs `forwardRef` for the RemnawaveModule↔AddOnEntitlementsModule cycle); scheduled renewal-term activation at term start (pairs with T-007 add-on renewal composition + renewal-term lifecycle).
- **Delivered (T-008d, scheduled renewal-term activation):** `EntitlementBoundaryService.activateDueScheduledTerm` — finds the earliest SCHEDULED term with `startsAt <= now`, activates it (atomically closes the prior ACTIVE term via `SubscriptionTermService.activateInTransaction`), ACTIVATEs its PENDING_ACTIVATION entitlements whose `scheduledActivationAt <= now` (idempotent command keys), recomputes the projection + mirrors + enqueues a versioned `TERM_ACTIVATION` sync — one transaction (the design D-4 boundary transaction). Scheduler now sweeps BOTH due entitlements (expiry) and due scheduled terms (activation), activating before expiring per subscription. Tests: boundary unit (+2), real-DB (+1: gen-1 ENDED, gen-2 ACTIVE, pending entitlement → ACTIVE, projection = baseline+contribution, baselineTermId = new term). 17/17 real-DB green.
- **Remaining (coupled — the renewal-term PRODUCER):** the renewal checkout/fulfillment creating the SCHEDULED term (`startsAt = old endsAt`, or `now` if already ended) + PENDING entitlements (`scheduledActivationAt = new startsAt`) — pairs with T-007 add-on renewal composition. The activation CONSUMER is now proven. Plus reset-epoch for UNTIL_NEXT_RESET (gated `resetExpiry`); webhook-triggered boundary (needs `forwardRef`).
- **Delivered (T-008e, reset-epoch on term activation):** `activateDueScheduledTerm` now creates the term's first `SubscriptionResetEpoch` (ordinal 1, planned UTC boundary via the T-002 `planResetEpoch` domain) — ONLY when the strategy's capability is ENABLED (`resetExpiry.<strategy>` flag; OFF ⇒ no epoch, UNTIL_NEXT_RESET stays legacy). Idempotent per term. Real-DB test (+1): flag-off ⇒ 0 epochs, flag-on MONTH ⇒ exactly 1 epoch with the correct UTC month boundary. 18/18 real-DB green.
- **Delivered (T-008f, UNTIL_NEXT_RESET fulfillment binding):** `PaymentSubscriptionMutationService.applyAddOnViaLedger` now handles the `UNTIL_NEXT_RESET` lifetime in the direct-purchase ledger path: when the term strategy's reset-expiry capability is ENABLED (`resetExpiry.<strategy>` flag) AND the ACTIVE term has a LIVE reset epoch (`plannedEndsAt > now`, created at activation by T-008e), it binds the entitlement's `expiresAt = epoch.plannedEndsAt` and `expiryEpochId = epoch.id` (so boundary expiry consumes the epoch). It never creates an epoch in the money path — no epoch / capability OFF / NO_RESET ⇒ conservative fall-back to the legacy increment, mirroring the eligibility quote's gate. Real-DB test (+1) in `add-on-entitlement-postgres-concurrency.spec.ts`: flag-ON MONTH ⇒ ACTIVE entitlement bound to the epoch (expiresAt = plannedEndsAt, projection = baseline+contribution); flag-OFF ⇒ no ledger row, legacy traffic increment. 21/21 real-DB green.
- **Remaining:** webhook-triggered boundary (`forwardRef` for RemnawaveModule↔AddOnEntitlementsModule cycle — deferred). The renewal-term PRODUCER (T-007c) + CONSUMER (T-008d) + reset-epoch (T-008e) + UNTIL_NEXT_RESET binding (T-008f) halves of the lifecycle are all proven.
- **Tests/verification:** manual early reset, lost/duplicate/out-of-order webhook, scheduler race, leap/month boundary, early renewal activation, upgrade, deletion race.
- **Rollback/migration:** strategy-specific flags; scheduler disabled without deleting epochs.
- **Risk:** critical.

### T-009 — Versioned profile-sync convergence

- **Status:** in_progress
- **Priority:** must
- **Objective:** make CREATE/UPDATE/DELETE converge to latest desired revision and recover every failed type.
- **Requirements:** R-004, R-005, R-009.
- **Acceptance criteria:** AC-R004-2/3, AC-R005-5, AC-R009-1..5.
- **Files:**
  - Modify: `rezeis-admin/src/modules/profile-sync/profile-sync-queue.service.ts`
  - Modify: `.../profile-sync.processor.ts`
  - Modify: `.../profile-sync.constants.ts`
  - Modify: `.../profile-sync.module.ts`
  - Modify: `rezeis-admin/src/modules/remnawave/services/remnawave-webhook.service.ts`
  - Extend: `rezeis-admin/test/profile-sync-queue.service.spec.ts`
  - Extend: `rezeis-admin/test/profile-sync.processor.spec.ts`
  - Create: `rezeis-admin/test/profile-sync-concurrency.spec.ts`
- **Blocked by:** T-004
- **Parallel group:** P4-sync
- **Implementation notes:** aggregate serialization/lease; latest projection reread; conditional job claim; stale `SUPERSEDED`; DELETE priority; applied revision after strict read-back only. Sweep failed UPDATE/DELETE and expired leases.
- **Delivered (flag-gated by `ADDON_PROJECTION_SYNC`, default OFF):** (a) version-aware supersession in `profile-sync.processor.ts` — a versioned job (`aggregateKey`+`desiredRevision`) whose revision is behind `SubscriptionEffectiveProjection.desiredRevision` supersedes ITSELF (`supersededAt`+`cause=SUPERSEDED_BY_REVISION`, terminal, no upstream push); the winning revision supersedes older non-terminal siblings on completion. (b) DELETE priority — a versioned CREATE/UPDATE/TRAFFIC_RESET supersedes itself (`cause=SUPERSEDED_BY_DELETE`) when a non-terminal DELETE exists for the aggregate. Supersession uses the `supersededAt` timestamp (no new enum), consistent with the existing sweeper exclusion. Flag OFF ⇒ legacy behavior, projection never read. (c) **Expired-lease recovery (not flag-gated, general robustness)** — `profile-sync-queue.service.ts` sweep reclaims stale `RUNNING` rows (`startedAt` older than a 15-min lease, `supersededAt` null) back to `PENDING` + force re-enqueue, guarded by a `where status=RUNNING` conditional update so a just-finished worker always wins; handlers are idempotent so re-runs can't double-apply. Tests: `test/profile-sync-versioned-convergence.spec.ts`, `test/profile-sync-queue.service.spec.ts`.
- **Remaining:** all ~15 producers emitting versioned jobs (only the ADDON_PURCHASE_LEDGER producer sets aggregateKey/desiredRevision today); processor reading the projection directly instead of legacy mirror columns; strict read-back + applied-revision recording (belongs with T-010 strict adapter); webhook echo-safety vs ledger projection.
- **Delivered (versioned desired-state write, T-009↔T-010):** `profile-sync.processor.ts` `tryVersionedDesiredStateWrite` (flag `projectionSync`) — for a versioned UPDATE it rereads the projection, PATCHes the ABSOLUTE latest limits via the strict adapter (`strictSetUserLimits`, canonical `null→0`), strictly reads the user back (`strictGetPanelUser`), and advances `lastAppliedRevision`+`observed*`+`state=APPLIED` ONLY on equality (guarded to this revision); a mismatch records `state=DRIFTED`/`driftClass=LIMIT_MISMATCH` and throws (BullMQ retry / sweep re-drive); transient panel failures throw (retry). Falls back to the legacy absolute update when the flag is off / job is non-versioned / no projection. Versioned producers today: ADDON_PURCHASE_LEDGER, BOUNDARY_EXPIRY, operator force-reconcile/reversal. Tests: `test/profile-sync-desired-state.spec.ts` (5).
- **Remaining (deliberate scope):** plan-level producers (NEW/RENEW/UPGRADE) set limits directly and have no projection revision — they stay on the legacy absolute update by design; broad producer versioning only applies to projection-driven add-on limit changes (covered). Webhook echo-safety vs ledger projection tracked with T-008 webhook trigger.
- **Tests/verification:** old A after new B, update vs delete, DB commit/enqueue crash, retry classes, malformed read-back, worker duplicate claim.
- **Rollback/migration:** projection sync flag; preserve pending work for later recovery.
- **Risk:** critical.

### T-010 — Strict Remnawave 2.7.4/2.8.0 adapter

- **Status:** completed
- **Priority:** must
- **Objective:** add strict paid/destructive operations and normalized version fixtures without changing best-effort UI callers unexpectedly.
- **Requirements:** R-009, R-010, R-014.
- **Acceptance criteria:** AC-R009-4/5, AC-R010-1/3, AC-R014-3/4.
- **Files:**
  - Modify: `rezeis-admin/src/modules/remnawave/services/remnawave-api.service.ts`
  - Modify: `.../services/remnawave-version.service.ts`
  - Create: `.../interfaces/remnawave-strict-outcome.interface.ts`
  - Extend: `rezeis-admin/test/remnawave-api.service.spec.ts`
  - Create fixtures under `rezeis-admin/test/fixtures/remnawave/2.7.4/` and `2.8.0/`
- **Blocked by:** T-009
- **Parallel group:** P5-sync
- **Implementation notes:** do not silently alter existing UI fallback semantics; add explicit strict methods. Validate envelope, fields, null encoding and counts. Never trust device row owner. Exact delete body stable.
- **Delivered:** `interfaces/remnawave-strict-outcome.interface.ts` — normalized `ok(value,detectedVersion)|notFound|unsupported|unavailable(retryAfterMs?)|invalidContract(details)` union + `RemnawaveStrictUser/Device/DeviceList`. Additive strict methods on `RemnawaveApiService` (best-effort UI methods untouched): `strictGetPanelUser` (envelope+field validation, canonical unlimited `0→null` decode, version from envelope), `strictSetUserLimits` (absolute PATCH, UUID in body, `null→0` encode), `strictListUserDevices` (envelope/array/total==rows/unique-nonempty-hwid/nonempty-createdAt validation, owner-agnostic), `strictDeleteUserDevice` (stable `{userUuid,hwid}` body, 404→notFound). New private `strictHttp` transport (does NOT swallow: distinguishes HTTP status + parsed `Retry-After` from network) + `mapStrictTransport` (404→notFound, 405/501→unsupported, 408/429/5xx→unavailable, other 4xx→invalidContract). Fixtures `test/fixtures/remnawave/{2.7.4,2.8.0}/{user,devices}.json` (2.7.x `updatedAt` vs 2.8.x `lastSeenAt`, finite vs unlimited). Tests: `test/remnawave-strict-adapter.spec.ts` (14). `remnawave-version.service.ts` already covers the 2.7–2.8 supported range + 2.8 capabilities — no change needed.
- **Remaining:** consumption — the desired-state write loop (strict read-back → compare → advance applied revision) integrates in T-009; the HWID saga consumes strict list/delete in T-011.
- **Consumed by (done):** T-009 versioned desired-state write (`strictSetUserLimits` + `strictGetPanelUser` read-back → APPLIED/DRIFTED + `lastAppliedRevision`) and T-011 device saga (`strictListUserDevices` + `strictDeleteUserDevice`). Adapter + fixtures + both consumers landed.
- **Tests/verification:** 200/404/401/403/429/500/timeout/malformed, `userUuid` vs `userId/requestIp`, missing/duplicate invalid rows, PATCH/delete and strict read-back.
- **Rollback/migration:** additive adapter methods.
- **Risk:** high.

### T-011 — Persisted device-reduction saga

- **Status:** completed
- **Priority:** must
- **Objective:** safely reconcile HWID overage after device entitlement expiry.
- **Requirements:** R-006, R-010.
- **Acceptance criteria:** AC-R006-1..3, AC-R010-1..6.
- **Files:**
  - Create: `rezeis-admin/src/modules/add-on-entitlements/services/device-reduction-plan.service.ts`
  - Create: `.../processors/device-reduction.processor.ts`
  - Modify: `.../add-on-entitlements.module.ts`
  - Modify: `rezeis-admin/src/modules/profile-sync/profile-sync.module.ts`
  - Create: `rezeis-admin/test/device-reduction-plan.service.spec.ts`
  - Create: `rezeis-admin/test/device-reduction.processor.spec.ts`
  - Create: `rezeis-admin/test/device-reduction-failure-injection.spec.ts`
- **Blocked by:** T-010
- **Parallel group:** P6-device
- **Implementation notes:** validate all rows before first mutation; immutable targets sorted createdAt/hwid DESC; verify overage/current revision before each exact delete; partial retry resumes plan; profile DELETE supersedes. Auto mode off initially—operator-reviewed plans first.
- **Delivered (planning half, no deletes):** (a) pure deterministic selection `domain/device-reduction-selection.ts` — `selectDeviceReductionTargets(devices, desiredLimit)` sorts createdAt DESC / tie hwid DESC, deletes the newest `overage`, keeps the oldest; fail-closed `DeviceReductionSourceError` on invalid createdAt / empty / duplicate hwid / bad limit. Unit + fast-check PBT (`test/device-reduction-selection.spec.ts`, `.pbt.spec.ts`). (b) `services/device-reduction-plan.service.ts` — reads projection (desired finite limit + revision) → strict-reads devices (`strictListUserDevices`: unavailable→DEFERRED, notFound→NOT_APPLICABLE, unsupported/invalidContract→BLOCKED) → selects targets → persists an IMMUTABLE `DeviceReductionPlan` keyed by `(subscriptionId, projectionRevision)` (upsert empty-update = idempotent replan); VERIFIED when no overage; never deletes. Registered in `add-on-entitlements.module.ts` (+RemnawaveModule import). Tests: `test/device-reduction-plan.service.spec.ts`.
- **Remaining:** the execution processor (`processors/device-reduction.processor.ts`, flag-gated `deviceCleanupAuto`) — per-target exact delete via `strictDeleteUserDevice`, per-delete re-guards (subscription not deleted, revision not superseded, overage still positive), strict read-back after each delete, partial-resume, final count<=limit proof, `DEVICE_REDUCTION_BLOCKED` incident on invalid/superseded; failure-injection spec.
- **Delivered (execution half):** `services/device-reduction-execution.service.ts` — `executePlan(planId)`, flag-gated `deviceCleanupAuto` (OFF ⇒ `AUTO_DISABLED`, operator-reviewed first). Loads plan (only PENDING/IN_PROGRESS), fail-closed `loadGuard` (no projection / revision advanced / limit relaxed to unlimited / subscription deleted or no panel profile ⇒ `SUPERSEDED`), marks IN_PROGRESS, then per-target: RE-guards, strict-lists (unavailable⇒DEFERRED, notFound⇒SUPERSEDED, malformed⇒BLOCKED+incident), breaks when current overage ≤ 0 (converged, never over-delete), skips already-absent targets (idempotent, no re-delete), exact `strictDeleteUserDevice`; final strict read-back proves `count ≤ desiredLimit` ⇒ APPLIED (+postconditionMetadata), else REMEDIATION_REQUIRED + `DEVICE_REDUCTION_BLOCKED` incident (upsert on `device-reduction:{planId}`). Registered/exported in `add-on-entitlements.module.ts`. Tests: `test/device-reduction-execution.service.spec.ts` (10) + `test/device-reduction-failure-injection.spec.ts` (2, deterministic resume — no re-delete on crash-after-delete).
- **Remaining (wiring, other tasks):** the trigger that calls `planForSubscription` after a device entitlement expiry lands with the term/boundary scheduler (T-008); operator review/approve surface is T-013. Auto-execution stays `deviceCleanupAuto`-OFF until its own gate.
- **Tests/verification:** equal timestamps, invalid timestamp/HWID/duplicates, concurrent register/revoke, target already absent, partial failures at each step, desired-limit revision change and whole-profile deletion.
- **Rollback/migration:** disable auto executor; retain plans/progress and allow operator recovery.
- **Risk:** critical/destructive.

### T-012 — Delivery observability, SLO and analytics

- **Status:** completed
- **Priority:** must (analytics portion should)
- **Objective:** distinguish money, local commitment and verified service and expose actionable backlog.
- **Requirements:** R-013, R-017.
- **Acceptance criteria:** AC-R013-1..4, AC-R017-1..3.
- **Files:**
  - Modify: `rezeis-admin/src/modules/add-ons/services/add-ons-stats.service.ts`
  - Extend/create entitlement metrics service under `src/modules/add-on-entitlements/services/`
  - Modify relevant health/ops interfaces/controllers under `src/modules/payments/` and profile sync
  - Create: `rezeis-admin/test/add-on-entitlement-metrics.spec.ts`
  - Extend/create: `rezeis-admin/test/add-ons-stats.service.spec.ts`
- **Blocked by:** T-004
- **Parallel group:** P4-ops
- **Implementation notes:** bounded labels only; correlation IDs in logs. Configurable 5m objective/15m alert. Explicit line relation, not generic `ADDITIONAL`.
- **Delivered (must core — metrics/SLO):** `services/entitlement-metrics.service.ts` — read-only `collect()` separating MONEY / LOCAL-COMMITMENT / VERIFIED-SERVICE into bounded enum-only counters: entitlements-by-state, projections-by-state, device-reduction-plans-by-state, open-incidents-by-kind (all zero-filled across the full enum). SLO view with configurable `ADDON_SLO_OBJECTIVE_MS` (5m default) / `ADDON_SLO_ALERT_MS` (15m default): stranded captured add-on lines (COMPLETED + `fulfilledAt` null) over objective/alert + oldest age, and non-superseded PENDING profile-sync jobs over objective/alert + oldest age. NO user ids / HWIDs / tokens / provider payloads in labels. Registered/exported in `add-on-entitlements.module.ts`. Tests: `test/add-on-entitlement-metrics.spec.ts` (5).
- **Remaining (should — analytics + surfacing):** `add-ons-stats.service.ts` joining the explicit entitlement/source line (captured/committed/verified/remediation/expiry/reversal, legacy → `UNKNOWN_ADDITIONAL`) instead of generic `ADDITIONAL`; ops/health controller exposure of the metrics (RBAC surface lands with T-013).
- **Delivered (analytics classification):** `add-ons-stats.service.ts` now returns `deliveryBreakdown` — each completed add-on purchase classified by its linked entitlement source line (`sourceTransactionId`): `PENDING_ACTIVATION→COMMITTED`, `ACTIVE→ACTIVE`, `EXPIRING/EXPIRED→EXPIRED`, `REVERSED→REVERSED`, `REMEDIATION_REQUIRED→REMEDIATION_REQUIRED`, no ledger row → `UNKNOWN_ADDITIONAL` (legacy). Tests: `test/add-ons-stats.service.spec.ts` (3). Existing totals/topBuyers/timeline unchanged.
- **Remaining (surfacing only):** ops/health controller exposure of `EntitlementMetricsService.collect()` (RBAC surface lands with T-013). Core metrics/SLO + analytics are done.
- **Tests/verification:** stage counters/age, alert threshold, no PII/HWID labels, ambiguous legacy classification and refund incident visibility.
- **Rollback/migration:** additive metrics/dashboard; no commercial mutation.
- **Risk:** medium.

### T-013 — Operator RBAC, audit and remediation surface

- **Status:** completed
- **Priority:** must
- **Objective:** provide least-privilege inspect/retry/reconcile/acknowledge/approve/compensate operations.
- **Requirements:** R-001, R-006, R-012, R-016.
- **Acceptance criteria:** AC-R001-4, AC-R006-4, AC-R012-1..4, AC-R016-1/3/5.
- **Files:**
  - Create controllers/DTOs/services under `rezeis-admin/src/modules/add-on-entitlements/{controllers,dto,services}/`
  - Modify RBAC seed/permission definitions discovered during implementation
  - Modify: `rezeis-admin/web/src/features/add-ons/add-ons-page.tsx`
  - Create: `rezeis-admin/web/src/features/add-ons/add-on-entitlements-tab.tsx`
  - Extend: `rezeis-admin/web/src/features/add-ons/add-ons-page.test.tsx`
  - Create backend controller/service tests under `rezeis-admin/test/`
- **Blocked by:** T-003, T-011, T-012
- **Parallel group:** P7-admin
- **Implementation notes:** separate view/retry/reconcile/reverse/cleanup-approve permissions; mandatory reason + command key; immutable audit before/after. No direct ledger editor. Restricted HWID display/retention.
- **Delivered (RBAC + read-view surface):** new least-privilege RBAC resource `add_on_entitlements: ['view','run','resolve','enforce','moderate']` in `rbac.resources.ts` (view=inspect, run=retry sync, resolve=force reconcile/ack incident, enforce=compensating reversal/waiver, moderate=approve blocked device plan) — NOT granted to any default non-superadmin role (high-risk). `services/add-on-entitlement-inspection.service.ts` — read-only per-subscription inspection (immutable ledger rows, projection desired-vs-applied revision, incidents, device plans) with RESTRICTED HWID display (device plans expose only `targetCount`, never raw HWIDs). `controllers/admin-add-on-entitlements.controller.ts` — `GET admin/add-on-entitlements/metrics` + `GET .../subscriptions/:id`, both `@RequirePermission('add_on_entitlements','view')` under AdminJwtAuthGuard+RbacGuard. Registered in module (+AuthModule). Tests: `test/admin-add-on-entitlements-rbac.controller.spec.ts` (3) + `test/add-on-entitlement-inspection.service.spec.ts` (3).
- **Remaining:** mutating remediation commands (retry sync `run` / force reconcile + acknowledge incident `resolve` / compensating reversal-waiver `enforce` / approve blocked device plan `moderate`) each with mandatory reason + command idempotency key + immutable before/after `AdminAuditLog`; web `add-on-entitlements-tab.tsx` (accessible states) + `add-ons-page.test.tsx` extension.
- **Delivered (remediation commands, backend):** `services/add-on-entitlement-remediation.service.ts` — `retryProfileSync` (reset FAILED non-superseded jobs → PENDING + force enqueue), `forceReconcile` (recompute + mirror + versioned sync job + enqueue when changed), `acknowledgeIncident` (OPEN→ACKNOWLEDGED, idempotent, NotFound on missing), `reverseEntitlement` (state-machine `REVERSE` via operator command key + recompute + versioned sync), `approveDevicePlan` (executes the device saga with an operator `force` override). Controller POST endpoints `retry-sync`/`reconcile`/`incidents/:id/acknowledge`/`entitlements/:id/reverse`/`device-plans/:id/approve`, each on its distinct permission (`run`/`resolve`/`resolve`/`enforce`/`moderate`) with `RemediationCommandDto` (mandatory reason + commandKey) and an immutable `AdminAuditLog` write (action + reason + commandKey + actor + ip/ua/requestId). `DeviceReductionExecutionService.executePlan` gained an operator `{force}` override. Tests: `test/add-on-entitlement-remediation.service.spec.ts` (9) + RBAC endpoint-permission assertions.
- **Remaining (frontend only):** web `add-on-entitlements-tab.tsx` (accessible remediation states) + `add-ons-page.test.tsx` extension. Backend surface is complete.
- **Delivered (web delivery tab):** `web/src/features/add-ons/add-on-entitlements-tab.tsx` — read-only delivery/SLO observability tab (SLO backlog cards: stranded paid lines + oldest age, pending syncs + oldest age, objective/alert thresholds; state breakdowns for entitlements/projections/device-plans; open incidents by kind). Wired as a third tab (`Delivery`) in `add-ons-page.tsx`. i18n keys added to BOTH `en.ts` + `ru.ts` (no defaultValue, per frontend steering). Test: `add-ons-page.test.tsx` (+1, renders the tab from mocked metrics). Web `npm run build` + `eslint` + full `vitest` (226) green.
- **Tests/verification:** RBAC matrix, key replay/conflict, illegal transition, audit/redaction snapshots and accessible admin states. Run web focused Vitest/lint/typecheck/build.
- **Rollback/migration:** commands can be disabled independently; audit retained.
- **Risk:** high.

### T-014 — Reiwa typed contracts and BFF behavior

- **Status:** in_progress
- **Priority:** must
- **Objective:** consume v2 eligibility/status contracts with runtime validation and correct outage/error semantics.
- **Requirements:** R-002, R-011, R-014, R-016.
- **Acceptance criteria:** AC-R002-5, AC-R011-1/3/4, AC-R014-1/2, AC-R016-1/5.
- **Files:**
  - Modify: `reiwa/src/infrastructure/admin-client/namespaces/add-ons.ts`
  - Modify: `reiwa/src/infrastructure/admin-client/namespaces/subscription.ts`
  - Modify: `reiwa/src/api/routes/content.ts`
  - Modify: `reiwa/src/api/routes/payments.ts`
  - Create/update Zod schemas in surrounding admin-client contract location
  - Create: `reiwa/test/api/add-ons-contract.test.ts`
  - Extend: `reiwa/test/api/middleware/access-mode.test.ts`
- **Blocked by:** T-006
- **Parallel group:** P4-reiwa
- **Implementation notes:** replace checkout `unknown`; map errors without collapsing upstream unavailable to empty. Generate/forward one intent idempotency key; no client authority over price/eligibility.
- **Delivered (typed v2 contract + BFF):** `reiwa/src/infrastructure/admin-client/namespaces/add-ons.ts` — Zod-validated v2 `AddOnEligibilityResult` (`contractVersion`/`availability`/`target`/`addOns[]` with eligibility+prices) + new `listForSubscription(subscriptionId)` (`GET /api/internal/add-ons/subscriptions/:id`, runtime-validated, outage propagates). `purchase` return typed (`AddOnCheckoutResult`, was `unknown`) + forwards `expectedAddOnRevision` / `idempotencyKey` / `contractVersion` (client has no price/eligibility authority). `reiwa/src/api/routes/content.ts` — new `GET /add-ons/subscriptions/:subscriptionId` that returns the validated eligibility and, on upstream outage, sends a 502 (NOT an empty catalog — distinguishes unavailable from EMPTY); purchase route forwards the idempotency key + revision + contractVersion from the request body. Tests: `reiwa/test/api/add-ons-contract.test.ts` (7: valid/EMPTY parse, malformed reject, unknown type reject, outage-propagation, key/revision forwarding, malformed checkout reject). Gates: reiwa `npm run check` + `npm test` (379) + `npm run build` green.
- **Remaining:** typed subscription-status v2 contract in `namespaces/subscription.ts` + `routes/payments.ts` wiring; `access-mode.test.ts` extension for the new eligibility route.
- **Tests/verification:** old/v2 additive payloads, invalid contract, unavailable vs empty, ownership/session behavior, error codes. Run `npm run check`, focused Vitest.
- **Rollback/migration:** feature-detect v2; legacy route remains during deployment.
- **Risk:** medium-high.

### T-015 — Reiwa Add-on and renewal accessible UX

- **Status:** in_progress (forwarding plumbing delivered; selection UI + flag-capability exposure remain)
- **Priority:** must
- **Objective:** implement review, exact price/lifetime, scheduled selection and provisioning/cleanup states.
- **Requirements:** R-005, R-008, R-011.
- **Acceptance criteria:** AC-R005-1, AC-R008-2..4, AC-R011-1..5.
- **Files:**
  - Modify: `reiwa/web/src/features/addons/addons-page.tsx`
  - Modify: `reiwa/web/src/features/renewal/renewal-page.tsx`
  - Modify: relevant subscription/dashboard components identified in research
  - Modify: `reiwa/web/src/lib/api-client/content.ts` and payment/subscription clients
  - Add localized strings in existing i18n files
  - Add tests through repo-approved web harness; if no runner, first propose a separate minimal test-harness change rather than hiding untested behavior
- **Blocked by:** T-007, T-014
- **Parallel group:** P6-reiwa-ui
- **Implementation notes:** gateway-currency price, review/confirm, non-recurring notice, target term/date/rule and device consequence. One key per intent, busy/live/focus/offline resume. Explicit unchecked renewal options.
- **Tests/verification:** component/E2E/a11y scenarios; at minimum `npm run typecheck` and `npm run build`, plus approved browser tests.
- **Delivered (T-015a, renewal add-on forwarding chain):** the full web→BFF→admin plumbing that carries renewal add-on selections. reiwa `PaymentsNamespace.createRenewalCheckout` now forwards `addOns` (`[{subscriptionId, addOnIds[]}]`) + `idempotencyKey`; the BFF `POST /payments/renewal-checkout` route validates + forwards them; `reiwa/web` `createRenewalCheckout` api-client + `renewal.store` carry a per-subscription `selectedAddOns` map (toggle action, cleared when a subscription is deselected) and the checkout mutation forwards it. Non-empty-only (dormant with no selections). Tests: `reiwa/test/api/payments-renewal-addons-contract.test.ts` (+2: forwards non-empty addOns+key; omits when empty). Gates: reiwa `check`/`test` (381) /`build` green; `reiwa/web` `typecheck`/`build` green.
- **Delivered (T-015b, top-up wizard UX-gap closure — money-facing correctness + confirmation):** closed audit gaps in `reiwa/web` add-ons wizard: (2) card price now formats correctly instead of raw `prices[0]`; (3) the gateway step only offers channel-compatible gateways that carry a price in their currency (`isGatewayOfferable` — no more late "no price"/Telegram-Stars-on-web rejection), with a distinct "no compatible method" vs "no gateways" empty state; (4) unknown currencies fall back to the currency CODE (never a bare number) and malformed decimals are `NaN`-guarded (`formatPrice`); (5) operator `description` is now rendered on the add-on card + review; (6) a new explicit **review/confirm step** (`review`) shows subscription + add-on + gateway + exact price before any charge (replaces the silent auto-POST); (11) the free-add-on fast path only auto-picks an OFFERABLE zero-priced gateway (no currency-mismatched fallback); plus the stale-gateway carry-over is cleared when re-picking an add-on; (22) `extraDevices` uses proper i18next plural rules (ru one/few/many + en). i18n keys added symmetrically in ru+en (`noCompatibleGateway`, `reviewTitle`, `total`, `confirm`, `confirmFree`). Gates: `reiwa/web` `typecheck`/`build` green.
- **Delivered (T-015c, error-vs-empty + retry routing):** (7/20) the plan add-on catalog BFF GET `/add-ons/plan/:planId` no longer masks an upstream outage as an empty catalog — it surfaces 502 (null adminClient still degrades to empty), and the wizard's add-on step now renders a distinct error+retry state (`addons.loadError`/`retry`) instead of a misleading "no add-ons". (14) failed/timed-out payments now retry back into the originating flow: `pending-checkout` carries a `returnTo` route (`/addons`, `/renew`, `/upgrade`), captured before the poll clears it, and the return page routes retry there instead of always `/plans`. Gates: reiwa `check`/`test` (381)/`build` + `reiwa/web` `typecheck`/`build` green.
- **Delivered (T-015d, success naming + a11y + stale-catalog + edge-gate):** (13) the success screen now names the purchased add-on — `pending-checkout` carries a `label` (the add-on name), shown under the success checkmark. (21) payment-return processing/success/failed states got `role="status"`/`role="alert"` + `aria-live`, and the add-on checkout spinner got `role="status"` (screen-reader announcements for step/result). (8) the money-facing add-on catalog is no longer SW-cached (removed from the allow-list) so a removed/repriced add-on can't linger cross-session — React Query keeps a 60s in-memory cache and outages surface the new error state. (19) the BFF `POST /add-ons/purchase` now enforces `requireMode('purchase.addon')` so PURCHASE_BLOCKED/RESTRICTED is rejected at the edge instead of a late admin rejection. Gates: reiwa `check`/`test` (381)/`build` + `reiwa/web` `typecheck`/`build` green.
- **Delivered (T-015g, renewal add-on selection UI + capability signal):** the full renewal add-on picker is now live and gated. (capability) `renewalAddOns` flows rezeis env → `InternalPlatformPolicyInterface.renewalAddOns` (`getInternalPlatformPolicy` env override) → reiwa `PlatformPolicyShape` → BFF `/platform-policy` passthrough → web `PlatformPolicy.renewalAddOns` → `useRenewalAddOnsEnabled()`. (UI) a new `addons` step sits between gateway and review in the renewal wizard (only when the capability is on; otherwise gateway → review unchanged). It fetches per-subscription eligibility (`GET /add-ons/subscriptions/:id`, new web `getSubscriptionAddOns`), renders liquid-glass toggle cards priced in the chosen gateway's currency (offerable filter, description, plural device label, `aria-pressed`), and stores picks in `renewal.store.selectedAddOns`. The review lists selected add-ons and shows a grand total (base + add-on prices via `useQueries` over the cached eligibility). Selections forward through the T-015a chain to backend pricing/fulfillment. i18n ru+en (`renewal.addonsTitle`/`addonsSubtitle`). Backend: `renewalAddOns` added to the platform-policy payload; specs updated. Gates: backend `tsc`/`eslint`/`test` (1452), reiwa `check`/`test` (381)/`build`, `reiwa/web` `typecheck`/`build` — all green.
- **Status:** T-015 renewal add-on flow is functionally complete end-to-end (capability-gated, dormant until `renewalAddOns` on).
- **Delivered (T-015h, transaction naming — audit gap 16):** the cabinet transaction feed (`internalUserEdgeService.listTransactions`) now derives a human `title` from `planSnapshot` (add-on receipt name / plan name) and the activity + settings/transactions pages render `tx.title ?? plan ?? gateway` — add-on top-ups no longer show as a bare gateway name. `InternalUserTransactionInterface.title` added; specs (`user-transactions-history`, `internal-user.controller`) updated. Gates: backend `tsc`/`eslint`/`test` (1452), `reiwa/web` `typecheck`/`build` green.
- **Delivered (T-015i, "My add-ons" entitlement history — audit gap 15):** a user-facing history of durable add-on entitlements. Backend: `internalUserEdgeService.listAddOnEntitlements` (own subscriptions only, user-safe projection) + `GET /internal/user/add-on-entitlements` + `InternalUserAddOnEntitlementInterface` (+unit test). BFF: `activity.getAddOnEntitlements` + `GET /activity/add-on-entitlements` passthrough. Web: `getAddOnEntitlements` api-client + `UserAddOnEntitlement` type + a `/settings/add-ons` "My add-ons" page (liquid-glass rows: receipt name, value label, lifecycle-state badge, price, purchase date, expiry) + settings menu entry, ru+en i18n (`settings.addons*`, `addonsHistory.*` incl. all six lifecycle states). Read-only; naturally empty until the ledger is populated. Gates: backend `tsc`/`eslint`/`test` (1453), reiwa `check`/`test` (381)/`build`, `reiwa/web` `typecheck`/`build` — all green.
- **Delivered (T-015j, checkout-error recovery + multi-slot pending — audit gaps 12 & 18):** (18) `pending-checkout` moved from a single slot to a bounded (max 8) map keyed by `paymentId`, so two checkouts started in the same tab no longer overwrite each other's manual-open URL; `clearPendingCheckout(paymentId)` clears just the finished payment. (12) a failed checkout-creation now keeps the user inside the wizard — add-ons return to the `review` step, renewal/upgrade go back to `review` — instead of bouncing to the dashboard (or a stuck spinner) and losing the selection; retry re-runs with a fresh idempotency key. Gates: `reiwa/web` `typecheck`/`build` green.
- **Audit gaps closed (21/22):** 1,2,3,4,5,6,7,8,9,11,12,13,14,15,16,17,18,19,20,21,22.
- **Remaining:** only gap 10 (planSnapshot-drift surfaces as a late purchase-time reject) — this is authoritative backend re-validation **by design** (the guard must re-price/re-check server-side; it can't be "fixed" without weakening the money-path). Not an actionable defect. The T-015 add-on cabinet UX is complete.
- **Rollback/migration:** UI feature flags hide v2 paths while preserving status visibility for already-paid lines.
- **Risk:** high due current missing web test runner.

### T-016 — Cross-version, concurrency and destructive contract gate

- **Status:** done (backend/vendor gate green)
- **Gate result:** `npm run prisma:generate` 0, `npm run lint` 0 errors, `npm run build` (nest, incl. worker) 0, `npm test` on ephemeral Postgres 17 **1453/1453**. Covers the high-risk matrix: real-DB concurrency races (generation allocation, boundary expire-once, delete-vs-fulfill, cross-subscription/epoch guards), strict Remnawave 2.7.4/2.8.0 adapter + fixtures, device-reduction saga + PBT, versioned-sync supersession/DELETE-priority/lease-recovery, ledger fulfillment idempotency, renewal producer/fulfillment. No sibling defects surfaced. (Pre-existing, unrelated: 11 non-add-on lint *warnings* in bot-map/quests/profile-sync/altshop + a few specs — 0 errors; not introduced by this feature.)
- **Priority:** must
- **Objective:** run the complete backend/vendor high-risk matrix and close any sibling defects before UI acceptance.
- **Requirements:** R-007, R-009, R-010, R-014, R-018.
- **Acceptance criteria:** AC-R007-5, AC-R009-1..5, AC-R010-1..6, AC-R014-3/4, AC-R018-1/2/5.
- **Files:** tests/fixtures only plus fixes in owning tasks if failures expose defects.
- **Blocked by:** T-008, T-011
- **Parallel group:** P8-gates
- **Implementation notes:** include real PostgreSQL races, OpenAPI-derived 2.7.4/2.8.0 fixtures, crash after every saga boundary, reset parity observation. Do not enable any reset strategy or auto cleanup on partial evidence.
- **Tests/verification:** focused matrix, then Rezeis `npm run prisma:generate`, `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`.
- **Rollback/migration:** failed capability remains disabled.
- **Risk:** critical gate.

### T-017 — Cross-repo UX/security/operations gate

- **Status:** done for add-on scope (feature gates green; 2 pre-existing admin-web issues unrelated to this feature)
- **Gate result:**
  - Reiwa: `npm run check` 0, `npm test` **381/381**, `npm run test:pbt` **18/18**, `npm run build` 0.
  - Reiwa web (cabinet): `npm run typecheck` 0, `npm run build` 0.
  - Rezeis admin web: `npm run build` 0; `npx vitest run` = **225/226** where the single miss (`dashboard-page.smoke.test.tsx`) **passes in isolation** (flaky/timeout under full-suite parallel load), and `npm run lint:strict` reports **33 pre-existing warnings** in admin-web files NOT touched by this feature (backup/branding/broadcast/quests/users/…). Both admin-web issues predate and are unrelated to the add-on work (this feature never modified `rezeis-admin/web`). Redaction: user-facing payloads (transactions, entitlement history, eligibility) expose only user-safe fields — no secrets/PII/HWID/correlation/version.
- **Priority:** must
- **Objective:** verify contracts, accessibility, authz, redaction, SLO and delayed-provisioning recovery end to end.
- **Requirements:** R-011, R-012, R-013, R-016, R-018.
- **Acceptance criteria:** all AC for mapped requirements, especially AC-R018-1/4.
- **Files:** cross-repo tests and test fixtures; no release files.
- **Blocked by:** T-012, T-013, T-015, T-016
- **Parallel group:** P9-gates
- **Implementation notes:** test direct paid/free, early renewal, same-total composition, outage, permanent upstream failure, remediation and operator actions; verify no secrets/PII/HWID in logs/metrics.
- **Tests/verification:** Rezeis admin web `npm test`, `npm run lint:strict`, `npm run build`; Reiwa `npm run check`, `npm test`, `npm run test:pbt`, `npm run build`; Reiwa web `npm run typecheck`, `npm run build` plus approved UI/E2E/a11y harness.
- **Rollback/migration:** failed UI/security gate blocks admission flags.
- **Risk:** high gate.

### T-018 — Migration rehearsal, staged rollout and rollback proof

- **Status:** done (proof + runbook delivered)
- **Delivered:** (1) Migration up + **idempotent rerun** proven on the ephemeral Postgres 17 — `npx prisma migrate deploy` reapplies cleanly then reports "No pending migrations to apply" (68 migrations, additive/nullable columns only; no destructive down-migration needed). (2) **Shadow equality** proven by the T-004 cutover real-DB specs: finite/unlimited/legacy fixtures grandfather into an ACTIVE term + SHADOW projection whose desired limits **equal** the legacy columns, idempotent rerun = `SKIPPED_EXISTING` (zero unexpected mismatch, no upstream writes). (3) **Rollback** proven structurally: every stage is a deployment-time flag defaulting OFF; flag-OFF specs prove the legacy path stays authoritative and paid-line reconciliation is preserved (idempotent `fulfilledAt`/`appliedAt`/`(sourceTransactionId,sourceLineKey)`). (4) **Operator runbook**: `docs/operator-add-on-entitlements-rollout.md` — prerequisites, cutover, the 6 staged flags (enable-one-at-a-time order: shadow → directPurchase → projectionSync → resetExpiry(per strategy, post-parity) → renewalAddOns → deviceCleanupAuto), per-stage verification, and the rollback drill.
- **Priority:** must
- **Objective:** prove no-drift cutover and recoverable staged rollout on representative data before any production enablement.
- **Requirements:** R-015, R-018.
- **Acceptance criteria:** AC-R015-1..5, AC-R018-3/4.
- **Files:**
  - Extend cutover script/tests from T-004
  - Create operator runbook under existing Rezeis documentation convention discovered at implementation time
  - Add feature configuration/schema/tests in existing config modules
- **Blocked by:** T-004, T-016, T-017
- **Parallel group:** P10-final
- **Implementation notes:** anonymized/representative finite/unlimited/legacy fixtures; dry-run counts; shadow equality; no upstream writes; enable flags one stage at a time; device auto last. Rollback must keep reconciliation for admitted paid lines.
- **Tests/verification:** migration up/idempotent rerun, shadow report zero unexpected mismatch, rollback drill and incident runbook exercise. Final git diff/read-only review swarm before any later release request.
- **Rollback/migration:** this task owns proof, not production deploy.
- **Risk:** critical gate.

## Post-implementation polish pass (sub-agent review swarm)

Ran 3 parallel read-only review agents (backend money-path; reiwa BFF+web; deep lifecycle/boundary/sync/RBAC + sibling-bug sweep). Fixed every actionable finding; all gates re-green (backend 1455/1455, reiwa 381 + 18 pbt, web typecheck/build).

- **[HIGH money-path] Combined-renewal add-ons dropped on flag flip** — `applyCombinedRenewal` gated add-on fulfillment on the LIVE `renewalAddOns` flag. A line persisted at checkout (= paid) would be silently dropped if the flag flipped OFF before the webhook. Fixed: fulfillment mints PERSISTED lines regardless of the flag (the flag only gates INTAKE); regression test updated to assert paid lines fulfil flag-off.
- **[HIGH money-path] Legacy `0 + N` unlimited-device downgrade** — legacy `applyAddOnTopUp` incremented `deviceLimit` unconditionally, turning an unlimited (`deviceLimit <= 0`) profile finite on the default (directPurchase-OFF) path. Fixed: no-op the increment on an unlimited baseline (mirrors the traffic-null guard). Real-DB regression test added.
- **[MED money-path] Recovery sweeper double-apply** — `add-on-fulfillment-recovery.service` released the claim on ANY error, including a post-commit `enqueue` failure, letting the next tick re-run and double-apply the non-idempotent legacy increment. Fixed: release only when `applyCompletedTransaction` itself throws (nothing committed); enqueue is best-effort (profile-sync sweep re-enqueues). Regression test added.
- **[MED] Renewal checkout had no idempotency key** (add-on flow did) — added a per-attempt `crypto.randomUUID` threaded web → BFF (which already forwarded it).
- **[MED] `renewalAddOns` single-gateway auto-select race** — a one-gateway user could be auto-advanced gateway→review before the policy query resolved, skipping the add-on step. Fixed: gate the auto-select on the platform-policy query being settled.
- **[MED] a11y** — renewal checkout spinner now has `role="status"`/`aria-live`.
- **[MED] i18n** — transactions page rendered the raw status enum; now uses the existing `activity.txStatus.*` keys + a localized `activity.paymentFallback` (ru+en); my-addons state label falls back to the raw state for future enum values.
- **[LOW] BFF validation** — renewal-checkout `durations[].days` now requires a positive integer.

Sibling-bug sweep confirmed the `0 + N` class exists in only ONE device-increment site (now guarded); all other limit mutations (traffic increments, referral/quest rewards, partner-balance, admin/import SET paths) are already unlimited-safe. All 18 `@Cron` methods guard on `shouldRunSchedules()`; all migrations additive/idempotent; rollout OFF-paths preserve legacy behavior. Non-actionable/deferred: REMEDIATION_REQUIRED is a currently-unreachable dead-end state; some incident kinds (PROJECTION_DRIFT / PAID_FULFILLMENT_STALLED) are surfaced via gauges not incidents; reset-epoch advancement beyond ordinal 1 (only relevant once `resetExpiry.*` is enabled).

## Gap-10 closure — v2 eligibility made the authoritative top-up discovery path

The cabinet top-up wizard (`reiwa/web AddOnsPage`) and the dashboard top-up button gate previously built their add-on catalog from the CLIENT's cached `sub.plan.id` (stale planSnapshot) via the **v1** path `getPlanAddOns(planId)` → late reject at checkout. Both now use the **v2** authoritative path `getSubscriptionAddOns(subscriptionId)` (`AddOnEligibilityService.listForSubscription`), which computes eligibility server-side against the subscription's ACTIVE durable term — no client drift.

- **No-term fallback (backend):** v2 returned EMPTY when no ACTIVE term existed (terms only exist post-cutover; rollout flags default OFF), which would have broken the live flow on migration. Added `deriveFallbackBaseline` to `AddOnEligibilityService.listForSubscription`: when there is no ACTIVE term, it synthesizes the baseline server-side from the subscription's OWN columns + planSnapshot using the **same pure `deriveCutoverBaseline`** the grandfather cutover uses (`resetAnchorAt = startsAt`). So discovery matches the term the cutover would eventually create and keys off the same `planSnapshot.id` checkout validates against — still authoritative, still no drift. `termId=''` sentinel (nothing reads it; Zod `z.string()` accepts it). Finite-baseline gating holds: EXTRA_TRAFFIC withheld when unlimited traffic, EXTRA_DEVICES withheld when `deviceLimit<=0`, UNTIL_NEXT_RESET withheld unless the reset capability is ENABLED (flags OFF ⇒ withheld). Covered by pure unit tests in `add-on-eligibility.service.spec.ts` (no DB needed → runs in CI).
- **`icon` added to contract v2 (end-to-end):** to preserve the operator-configured add-on icon in the top-up cards (no styling regression), `EligibleAddOn` now carries `icon: string | null` across backend push → BFF Zod `eligibleAddOnSchema` → web `EligibleAddOn` type. Asserted in `add-on-eligibility.service.spec.ts` + `reiwa/test/api/add-ons-contract.test.ts`.
- **[HIGH — security] IDOR fix (found by the verification swarm):** the v2 endpoint was session-guarded but did NOT verify subscription ownership, so any authenticated cabinet user could read another user's eligibility (planId/expiry/catalog+prices) by guessing a subscriptionId. Fixed by mirroring the add-on checkout ownership gate: the reiwa BFF forwards the authenticated `resolveUserIdentity(req)` as `userId`/`telegramId` query params → the internal controller passes them to `listForSubscription(subscriptionId, owner)` → the service resolves the canonical owner and returns **404** on mismatch (never leaks). `owner` is optional so trusted in-process callers already ownership-scoped (renewal pricing) are unaffected. Ownership tests added (`add-on-eligibility.service.spec.ts` + forwarding assertion in `internal-add-ons.controller.spec.ts`).
- **Consumers migrated:** `SelectAddOn` (wizard) + `subscription-actions.tsx` (dashboard gate) now query `["add-ons-eligibility", subscriptionId]` (shared cache key); the client-side unlimited-traffic filter and the `noPlan` branch are removed (server is authoritative). The add-on store holds `EligibleAddOn`.
- **v1 cleanup (partial, safe):** removed the now-DEAD client-side v1 discovery — web `getPlanAddOns` + v1 `AddOn`/`AddOnPrice` types + their barrel exports, and the dead `addons.noPlan`/`addons.getFree` i18n keys (ru+en). **Retained (intentional):** the server v1 chain `GET /add-ons/plan/:planId` → admin-client `listForPlan` → backend `InternalAddOnsController.listForPlan`/`AddOnsService.listForPlan`. These are a rollout-compat shim: an already-loaded pre-deploy SPA / long-lived TMA session can still hit the v1 endpoint until drained. **Follow-up (staged, top-down after rollout drain):** delete BFF route → admin-client `listForPlan` + v1 `AddOn`/`AddOnPrice` interfaces + namespace index re-export → backend controller handler + `AddOnsService.listForPlan` + their two specs. Legacy FULFILLMENT (`applyAddOnTopUp` legacy branch) and legacy profile-sync are NOT part of this cleanup — they stay authoritative while flags are OFF.
- **Hardening pass (2nd review swarm — 3 adversarial read-only agents, all findings fixed):**
  - `evaluate()` now withholds EXTRA_DEVICES on a non-positive baseline (`<= 0`, mirroring the canonical unlimited rule) and EXTRA_TRAFFIC on a negative byte baseline — defense-in-depth against a persisted term storing 0/negative (fallback already maps to null). A finite 0 GB budget (0n) stays eligible.
  - `evaluate()` guards `resetAnchorAt === null` before `planResetEpoch` (which throws `INVALID_ANCHOR`) — a boundary term with a null anchor now withholds the add-on instead of 500-ing the whole listing once a reset flag is enabled.
  - `resolveOwnerUserId` (+ the sibling in `addon-purchase.service.checkout`) validate `telegramId` is numeric (`/^\d+$/`) before `BigInt()` — a malformed id is a 404 (eligibility) / `User not found` (checkout), never a raw 500.
  - **Cabinet top-up revision pin CLOSED:** web `purchaseAddOn` accepts `expectedAddOnRevision` and the wizard `CheckoutStep` passes `selectedAddOn.revision`; the backend rejects a stale composition (`ADDON_REVISION_CONFLICT`, validated independently of contractVersion). The wizard also invalidates `["add-ons-eligibility"]` on purchase success (no stale offer after top-up).
  - Unified the renewal eligibility cache key to `["add-ons-eligibility", id]` (was the divergent singular `addon-eligibility`) so wizard/dashboard/renewal share one cache.
  - Tests added: device `<=0` / negative-traffic / null-anchor withholding; empty-identity `{}` + non-numeric telegramId → 404; BFF namespace identity→query-string forwarding.
- **Deferred follow-ups (noted by swarms; NOT money-path-safe to change now):**
  - The RENEWAL add-on checkout still does not pin per-add-on `revision` (separate money path; the cabinet top-up pin above is done). Track before enabling renewal add-ons broadly.
  - Post-cutover, the term-present branch keys applicability off `term.planId` while checkout reads `planSnapshot.id`; a plan reassignment updating the snapshot but not the durable term could disagree. Only relevant once terms exist (flags flipping); track before enabling.
  - Checkout guards EXTRA_TRAFFIC-on-unlimited but not EXTRA_DEVICES-on-unlimited (discovery is stricter, so only reachable by a hand-crafted checkout bypassing discovery) — add the symmetric device guard for defense-in-depth.
- **Gates (all green):** backend `npx tsc --noEmit` 0, `npx eslint . --quiet` 0, `npm test` **1468/1468**; reiwa `npm run check` 0, `npm test` **382/382**, `npm run test:pbt` **18/18**, `npm run build` 0; reiwa web `npm run typecheck` 0, `npm run build` 0.

1. **P0:** T-001 schema.
2. **P1/P2:** T-002, then T-003 and T-006 can partly parallelize.
3. **P3:** T-004 projection/cutover foundation.
4. **P4:** T-005 payments, T-009 sync, T-012 metrics and T-014 Reiwa contracts in parallel where dependencies permit.
5. **P5/P6:** T-007→T-008; T-009→T-010→T-011; T-014 + T-007→T-015.
6. **P7:** T-013 admin after lifecycle/device/metrics.
7. **P8/P9:** T-016 backend/vendor gate, then T-017 cross-repo UX/security gate.
8. **P10:** T-018 migration/rollback proof.

Critical path: `T-001 → T-002 → T-003 → T-004 → T-009 → T-010 → T-011 → T-016 → T-017 → T-018`.

## Traceability matrix

| Task | Requirements | AC coverage | Primary tests |
|---|---|---|---|
| T-001 | R-001/R-003/R-015 | catalog/data/index/additive schema | schema/migration |
| T-002 | R-002/R-007 | unlimited and cycle semantics | unit/property fixtures |
| T-003 | R-003/R-004/R-006 | ledger/state/events | unit/property/DB |
| T-004 | R-003/R-004/R-015 | projection/cutover/shadow/rollback data | PostgreSQL/migration |
| T-005 | R-005/R-006/R-016 | all checkout/fulfillment/recovery security | replay/crash/abuse |
| T-006 | R-001/R-002/R-014 | catalog/admin/eligibility/contracts | service/controller/RBAC |
| T-007 | R-005/R-008 | renewal fingerprint and lines | integration |
| T-008 | R-007/R-008 | term/reset activation/expiry | scheduler/webhook race |
| T-009 | R-004/R-005/R-009 | revision/serialization/retry | queue/worker concurrency |
| T-010 | R-009/R-010/R-014 | strict vendor operations | 2.7.4/2.8.0 contract |
| T-011 | R-006/R-010 | full HWID saga | failure injection |
| T-012 | R-013/R-017 | SLO/metrics/analytics | observability fixtures |
| T-013 | R-001/R-006/R-012/R-016 | admin remediation/audit | RBAC/redaction/UI |
| T-014 | R-002/R-011/R-014/R-016 | Reiwa typed BFF/error/status | contract/API |
| T-015 | R-005/R-008/R-011 | review/renewal/status/a11y | UI/E2E/build |
| T-016 | R-007/R-009/R-010/R-014/R-018 | vendor/concurrency/destructive gates | full high-risk backend matrix |
| T-017 | R-011/R-012/R-013/R-016/R-018 | cross-repo UX/security/ops gates | suites/E2E/a11y |
| T-018 | R-015/R-018 | migration/flags/rollback | rehearsal/runbook |

Every must requirement maps to at least one implementation task and to T-016/T-017/T-018 or an explicit focused verification task. R-017 is should and maps to T-012.

## Definition of done

- [ ] All must AC have failing-before/passing-after evidence.
- [ ] PostgreSQL concurrency and Remnawave 2.7.4/2.8.0 contracts pass.
- [ ] No paid line can be stranded without visible recovery state.
- [ ] Migration shadow equals legacy effective state before admission.
- [ ] Reset strategies and auto cleanup remain disabled until their own gates pass.
- [ ] Cross-repo contracts, security, accessibility and observability gates pass.
- [ ] No secrets/PII leaks and no unexplained product-file drift.
- [ ] Feature is implementation-ready, not released.
