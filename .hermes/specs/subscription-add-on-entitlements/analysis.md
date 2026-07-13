---
spec_version: 1
created_at: 2026-07-11T20:25:00+03:00
workflow: requirements-first
status: passed
run_id: 20260711-200606-9e4bf3
---

# Временные Add-on entitlements — анализ требований

## 1. Inputs reviewed

- `requirements.md` — R-001…R-018 и AC.
- `_runs/20260711-200606-9e4bf3/research-handoff.md`.
- `research/00-swarm-index.md`, `01-codebase.md`, `02-domain-and-external.md`, `03-critic.md`.
- Source paths по Add-ons, payments, subscriptions, profile sync, Remnawave, Reiwa catalog/renewal/device UI.
- Supplied Remnawave OpenAPI 2.7.4 и 2.8.0.
- Rezeis domain quality gates, multi-version entitlement checklist и temporary-entitlement checks.

## 2. Gate findings

| ID | Severity | Category | Finding | Resolution |
|---|---|---|---|---|
| A-001 | blocker | domain model | `trafficLimit/deviceLimit` не могут быть одновременно baseline и effective state. | **Resolved:** R-003/R-004 require service-term baseline, ledger, projection and observed state as separate layers. |
| A-002 | blocker | lifecycle | “Subscription end” неоднозначен при early renewal/upgrade. | **Resolved:** target is immutable service-term end; new term requires explicit reselection (R-008). This is the only interpretation consistent with one-time/non-recurring decision. |
| A-003 | major | semantics | `UNTIL_NEXT_RESET` for device Add-on could be mistaken for device reset. | **Resolved:** the boundary is the subscription traffic-cycle epoch for both Add-on types; HWID cleanup follows projection reduction (R-007/R-010). |
| A-004 | blocker | external contract | Vendor does not expose/document exact next reset formula. | **Resolved/contained:** local UTC cycle policy; per-strategy feature capability remains disabled until fixture parity is verified. No vendor enum-name inference (R-002/R-007/R-018). |
| A-005 | blocker | migration | Historical effective values cannot be decomposed safely. | **Resolved:** current local effective value becomes cutover baseline; only post-cutover checkout lines become managed entitlements (R-015). |
| A-006 | blocker | payment reliability | COMPLETED can precede service delivery; free path lacks recovery. | **Resolved:** four-layer idempotency, atomic free commit/outbox, paid-undelivered sweeper and explicit stages (R-005/R-006/R-013). |
| A-007 | major | checkout | Quantity/stacking composition unclear. | **Resolved:** quantity per v1 line is fixed at 1; stacking is multiple distinct purchases/lines, each unique and independently expiring (Terms/R-003). |
| A-008 | blocker | concurrency | Absolute sync can complete out of order. | **Resolved:** per-subscription serialization/coalescing, monotonic revision, latest reread, supersede and strict read-back (R-009). |
| A-009 | blocker | destructive safety | Device list failures/invalid ordering can cause wrong deletion. | **Resolved:** strict discriminated adapter, full prevalidation, immutable plan, exact delete, retry/read-back saga and blocked state (R-010). |
| A-010 | major | eligibility | Unlimited sentinel arithmetic and status/applicability races. | **Resolved:** canonical unlimited, three-layer fail-closed eligibility, capture-time remediation policy (R-002/R-005). |
| A-011 | major | reversal | Refund/chargeback semantics unsupported by current payment state machine. | **Resolved as bounded v1 scope:** immutable incident/operator remediation; no automatic clawback promise (R-006/R-012/R-017). Automatic reversal requires a separate approved payment-state spec. |
| A-012 | major | source of truth | Remnawave webhook currently writes limits back locally. | **Resolved:** observed state is separate and cannot mutate baseline/ledger; drift is reconciled outward (R-004/R-009). |
| A-013 | major | contract drift | Reiwa types/outage behavior and Remnawave versions are not strict enough. | **Resolved:** typed/versioned producer-consumer DTOs, explicit unavailable/invalid states and version fixtures (R-011/R-014). |
| A-014 | major | UX/accessibility | Current flow starts checkout without lifetime review and hides outages. | **Resolved:** review/confirm, exact gateway price/lifetime, provisioning state, accessibility/offline/error requirements (R-011). |
| A-015 | major | operations | No entitlement-specific RBAC, audit, SLO or remediation. | **Resolved:** R-012/R-013/R-016 define least privilege, immutable audit, redaction, metrics and SLO. |
| A-016 | major | rollout | Backfill or destructive cleanup could mutate production prematurely. | **Resolved:** additive migration, no-write dry run/shadow equality, staged flags, cleanup enabled last and rollback retained (R-015/R-018). |
| A-017 | minor | analytics | `PurchaseType.ADDITIONAL` conflates products. | **Resolved:** explicit line/entitlement relation and `UNKNOWN_ADDITIONAL` legacy class (R-017). |
| A-018 | question | scope | Does `rezeis-subpage` consume affected data? | **Resolved by research:** no relevant dependency found; remains out of scope. |

## 3. Atomicity and testability review

- [x] Every R-* has one normative EARS statement.
- [x] Every R-* has concrete numbered AC and explicit boundary/error behavior.
- [x] Actors, resources, units and state triggers are defined.
- [x] Decimal money and quantity semantics are explicit.
- [x] Direct purchase, free path, renewal, upgrade, expiry, deletion, refund incident and operator recovery are covered.
- [x] Request/provider/webhook/fulfillment idempotency are separate.
- [x] Concurrent purchase/expiry/reset/sync/delete outcomes are constrained.
- [x] Auth, ownership, RBAC, rate limits, PII and audit are covered.
- [x] Rezeis↔Reiwa and Remnawave 2.7.4/2.8.0 compatibility are testable.
- [x] Migration, shadow mode, staged rollout and rollback are observable.
- [x] Accessibility, outage, offline and delayed provisioning states are testable.
- [x] Each must requirement has planned design/task/test traceability.

## 4. Feasibility assessment

### Stack feasibility

- Prisma/PostgreSQL can enforce unique source lines, term/entitlement relations and monotonic revisions.
- Existing DB-backed `ProfileSyncJob`, webhook inbox and queue worker provide seams for transactional outbox/recovery, but UPDATE convergence must be extended.
- Existing Remnawave endpoints support absolute user updates, strict reads and exact HWID deletes in both required versions.
- Existing Reiwa BFF/SPA surfaces can add versioned DTOs, review steps and status summaries.

### Performance/capacity

Projection is a per-subscription aggregate over active rows and can be transactionally materialized. Required indexes by subscription/status/activation/expiry and due-job state bound scheduler queries. No global synchronous recomputation is required.

### Security/privacy

No new secret is needed. Existing session/Telegram verification, internal admin auth and RBAC remain trust boundaries. HWID is restricted identifier and excluded from metrics/general logs. Destructive operations are server-side only.

## 5. Requirement quality issues corrected in draft

1. Replaced vague “expiration at reset” with local epoch, planned boundary and webhook role.
2. Split financial completion, local commit and upstream verification.
3. Added fulfillment-time incompatibility/remediation instead of silent no-op.
4. Added immutable target term and early-renewal activation.
5. Added deterministic HWID tie-break, persisted plan and partial-success retry.
6. Added rollout capability gates rather than one global flag.
7. Made legacy grandfathering explicit and prohibited historical subtraction.
8. Made `LIMITED` eligible but all other non-active lifecycle states ineligible for direct purchase.

## 6. Decisions and assumptions

| ID | Decision / assumption | Impact | Status |
|---|---|---|---|
| DEC-001 | Lifetime belongs to each catalog option; default `UNTIL_NEXT_RESET`. | DTO/schema/UI snapshot. | user decision |
| DEC-002 | A one-time entitlement is scoped to one immutable service term. | No free extension through renewal/upgrade. | derived from user non-recurring decision; subject to spec approval |
| DEC-003 | Device `UNTIL_NEXT_RESET` uses the same subscription traffic-cycle boundary. | Device cleanup can occur at cycle boundary. | explicit spec interpretation; subject to approval |
| DEC-004 | Quantity per checkout line is 1; multiple purchases stack. | Avoids cart/quantity complexity in v1. | bounded v1 decision |
| DEC-005 | Current local effective limits are cutover baseline. | Legacy paid/reward effects remain permanent. | safety decision |
| DEC-006 | Refund/chargeback auto-clawback is out of v1. | Operator incident/remediation only. | bounded by current state machine |
| DEC-007 | UTC local cycle policies are enabled per strategy after staging parity. | Unknown vendor formula cannot cause premature expiry. | bounded assumption |
| DEC-008 | Newest device means `createdAt DESC`, tie `canonical hwid DESC`. | Deterministic cross-version cleanup. | accepted safety rule |
| DEC-009 | 99%/5 min and 15 min alert are initial configurable SLO defaults. | Observable rollout target. | tunable assumption |

## 7. Scope-control review

Excluded deliberately:

- generalized rewards migration (promo/quest/referral remain grandfathered baseline in v1);
- recurring Add-on billing/cart quantities;
- automatic refund/chargeback accounting/reversal redesign;
- changes to Remnawave subscription page fork;
- new payment provider behavior beyond idempotency/reference use;
- release/version/tag/deploy work.

## 8. Gate result

- **Result:** `passed`.
- **Unresolved blockers/majors:** none.
- **Open questions:** no question blocks design; DEC-002/003/004/006/007/009 are highlighted for user review.
- **Residual risk:** calendar parity remains externally unverified; fail-closed rollout makes it non-blocking for architecture/tasks.
- **Next artifact allowed:** `design.md`.
- **Implementation approval:** not granted.
