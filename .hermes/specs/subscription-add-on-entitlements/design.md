---
spec_version: 1
created_at: 2026-07-11T20:32:00+03:00
workflow: requirements-first
status: ready-for-review
run_id: 20260711-200606-9e4bf3
---

# Временные Add-on entitlements — технический дизайн

## D-1. Context, goals and non-goals

### Problem

Current fulfillment directly increments mutable subscription limits. It cannot explain provenance, expire one purchase, survive renewal correctly, recover captured-but-undelivered service, or safely reduce HWIDs. Remnawave absolute writes and reverse webhook updates also permit stale or upstream state to override commercial truth.

### Goals

1. Rezeis owns deterministic commercial state: term baseline + entitlement ledger.
2. Every new captured Add-on line converges to active/expired/remediation with audit.
3. Remnawave 2.7.4/2.8.0 receives only the latest absolute desired projection.
4. Manual reset cannot expire a commercial entitlement.
5. Device reduction is deterministic, fail-closed and retryable.
6. Reiwa exposes typed eligibility, review, renewal selection and delivery status.
7. Legacy effective limits remain unchanged at cutover.

### Non-goals

Recurring Add-ons, multi-quantity cart lines, generalized reward-ledger migration, automatic refund/chargeback clawback, `rezeis-subpage`, provider redesign and release actions.

## D-2. Current and proposed architecture

### Current

```text
AddOn catalog
  → checkout Transaction JSON marker
  → COMPLETED / fulfilledAt
  → increment Subscription.trafficLimit|deviceLimit
  → ProfileSyncJob
  → absolute Remnawave PATCH
```

Load-bearing evidence: `research/01-codebase.md` and `_runs/.../research-handoff.md`.

### Proposed

```text
                    ┌──────────────── commercial truth ────────────────┐
Admin catalog ─────→│ AddOn revision/lifetime                           │
Payment line ──────→│ ServiceTerm baseline + AddOnEntitlement ledger    │
Reset/renewal ─────→│ ResetEpoch + lifecycle transitions                │
                    └────────────────────┬───────────────────────────────┘
                                         │ atomic recompute
                                         ▼
                           EffectiveProjection(desiredRevision)
                                         │ transactional durable job
                                         ▼
                          per-subscription sync coordinator
                              ┌──────────┴──────────┐
                              ▼                     ▼
                    strict user PATCH/read   DeviceReduction saga
                              │                     │
                              └──────────┬──────────┘
                                         ▼
                         Observed Remnawave state/drift

Reiwa BFF/SPA ← typed catalog/checkout/renewal/entitlement summary ← Rezeis
Operator UI   ← ledger/projection/jobs/incidents/audit             ← Rezeis
```

### Ownership rules

- **Rezeis ledger/term:** commercial source of truth.
- **Desired projection:** only state allowed to drive Remnawave limit mutations.
- **Observed Remnawave state:** reconciliation evidence only; never baseline input.
- **Reiwa:** untrusted presentation/edge; server eligibility and money are authoritative.
- **Payment provider:** financial observation; not entitlement lifecycle authority.

## D-3. Components and data model

### Component boundaries

| Component | Responsibility | Existing/change location |
|---|---|---|
| Add-on catalog | Lifetime, archive, revision, prices/applicability | extend `src/modules/add-ons/**` |
| Entitlement domain | terms, epochs, ledger transitions, projection | create `src/modules/add-on-entitlements/**` |
| Payment composition | idempotent direct/renewal drafts and immutable lines | extend `src/modules/payments/**` |
| Projection sync | latest-revision absolute writes and recovery | extend `src/modules/profile-sync/**` |
| Remnawave capability adapter | strict normalized user/HWID operations for 2.7.4/2.8.0 | extend `src/modules/remnawave/**` |
| Device reduction | persisted exact-HWID saga | under entitlement/profile-sync boundary; no UI selection |
| Reiwa contracts/UI | typed edge DTOs, review/status/renewal | `reiwa/src/**`, `reiwa/web/src/**` |
| Admin operations | inspect/retry/acknowledge/approve with RBAC/audit | Rezeis admin controllers/web |

### Proposed Prisma models

Names are normative design names; implementation may split files but not merge semantic layers.

#### `AddOn`

Add:

- `lifetime AddOnLifetime @default(UNTIL_NEXT_RESET)`;
- `revision Int @default(1)` incremented on commercial field changes;
- `archivedAt DateTime?`.

`AddOnLifetime = UNTIL_NEXT_RESET | UNTIL_SUBSCRIPTION_END`.

Referenced rows cannot be hard-deleted. Snapshot data must not depend on the catalog FK.

#### `SubscriptionTerm`

- `id`, `subscriptionId`, monotonic `generation`;
- `planId?`, `planRevision?`, immutable plan snapshot;
- `startsAt`, `endsAt`, `status = SCHEDULED|ACTIVE|ENDED|CANCELED|RECONCILIATION_REQUIRED`;
- canonical `baseTrafficLimitBytes BigInt?` (`null` = unlimited);
- canonical `baseDeviceLimit Int?` (`null` = unlimited);
- `trafficResetStrategy`, `resetAnchorAt`, `createdAt`, `endedAt?`;
- unique `(subscriptionId,generation)`; at most one active term per subscription via transactional invariant/partial-index migration if supported.

Existing public `Subscription.trafficLimit/deviceLimit` remain compatibility materialized effective columns during rollout; they are never baseline after cutover.

#### `SubscriptionResetEpoch`

- `id`, `termId`, `ordinal`, `startsAt`, `plannedEndsAt`, `closedAt?`, `closeSource?`;
- unique `(termId,ordinal)` and `(termId,plannedEndsAt)`;
- only scheduler/calendar policy closes the matching planned epoch; webhook records can accelerate the same transition but not select a different epoch.

#### `AddOnEntitlement`

- `id`, `subscriptionId`, `termId`;
- `sourceTransactionId`, `sourceLineKey`, unique `(sourceTransactionId,sourceLineKey)`;
- immutable snapshot: `addOnId?`, `catalogRevision`, receipt-safe name, type, `valuePerUnit`, `quantity=1`, `totalValue`, lifetime, applicability basis, unit/total Decimal, currency;
- `purchasedAt`, `scheduledActivationAt`, `activatedAt?`;
- `expiresAt`, `expiryEpochId?` captured once;
- state `PENDING_ACTIVATION|ACTIVE|EXPIRING|EXPIRED|REVERSED|REMEDIATION_REQUIRED`;
- terminal reason/timestamps and optimistic `version`;
- no updates to commercial snapshot columns after insert.

State transitions are represented by immutable `AddOnEntitlementEvent` rows (`from`, `to`, reason, actor/system, correlation ID, metadata-redacted timestamp). The aggregate row materializes current state for efficient queries.

#### `SubscriptionEffectiveProjection`

One row per subscription:

- `subscriptionId` unique;
- `desiredRevision BigInt` monotonic;
- baseline IDs/limits, active traffic/device contribution totals;
- desired effective traffic/device limits using canonical nullable unlimited;
- `state = SHADOW|PENDING|APPLIED|DRIFTED|REMEDIATION_REQUIRED|DELETED`;
- `lastAppliedRevision?`, `lastAppliedAt?`;
- normalized observed limits, observed timestamp/contract version/drift class;
- timestamps.

Formula:

```text
effectiveTraffic = baseTraffic is unlimited
  ? unlimited
  : baseTraffic + SUM(ACTIVE EXTRA_TRAFFIC.totalValue)

effectiveDevices = baseDevices is unlimited
  ? unlimited
  : baseDevices + SUM(ACTIVE EXTRA_DEVICES.totalValue)
```

Use checked integer/BigInt arithmetic; overflow is a validation failure, never wraparound.

#### Durable work and incidents

Extend `ProfileSyncJob` with `desiredRevision`, `aggregateKey=subscriptionId`, `cause`, `supersededAt?`, and recovery metadata. Add:

- `DeviceReductionPlan`: subscription, projection revision, desired limit, immutable selected identifiers/timestamps, state, attempt/error/postcondition metadata;
- optional normalized item rows when needed for per-delete progress;
- `EntitlementIncident`: kind, severity, target IDs, state, operator acknowledgement/remediation, no raw provider payload/HWID in ordinary fields.

### Core invariants

1. One source transaction line creates at most one entitlement.
2. One term generation and projection revision are monotonic per subscription.
3. Unlimited is canonical `null` in new domain and absorbing in projection.
4. Ledger snapshots/events are append-only; correction is a compensating transition.
5. Entitlement/projection/job changes commit together.
6. Observed upstream state cannot update baseline or ledger.
7. No automatic HWID mutation without a fully validated persisted plan.
8. Subscription deletion supersedes UPDATE and device-reduction work.

## D-4. State machines and domain flows

### Entitlement lifecycle

```text
checkout/capture
  → PENDING_ACTIVATION ── term starts ──→ ACTIVE
         │ invalid target after capture       │ boundary reached / term ends
         └────────→ REMEDIATION_REQUIRED      ▼
                                             EXPIRING
                                                │ projection applied + cleanup verified/none
                                                ▼
                                             EXPIRED

ACTIVE/EXPIRED ── explicit approved compensation ─→ REVERSED
any recoverable technical failure keeps lifecycle intent and marks projection/incident remediation;
it does not erase the entitlement.
```

### Direct paid flow

1. Reiwa sends verified identity context, target subscription, Add-on ID and client idempotency key.
2. Rezeis authorizes ownership and computes server eligibility/price.
3. Canonical fingerprint includes user/subscription/active term/Add-on revision/type/value/lifetime/quantity=1/gateway/channel/currency/amount.
4. Equivalent key/request returns existing live draft. Key with different fingerprint returns `IDEMPOTENCY_KEY_CONFLICT`.
5. Provider create uses stable merchant reference/idempotency capability. Unknown response becomes `PROVIDER_OUTCOME_UNKNOWN`; no second checkout until reconciliation.
6. On capture, Rezeis claims source line and atomically inserts entitlement, recomputes projection and inserts sync work. Free path performs completion in the same transaction.
7. User response distinguishes `payment_pending`, `paid_activation_pending`, `active`, `remediation_required`.
8. Sweeper claims captured/completed source lines without entitlement and stalled projections.

### Early renewal flow

```text
current term ACTIVE ─────────────── endsAt
checkout now: renewal + selected Add-ons
  → new term SCHEDULED(startsAt=old endsAt)
  → entitlements PENDING_ACTIVATION(scheduledActivationAt=new startsAt)
  → no contribution yet
boundary transaction:
  close old term/entitlements + activate new term/selected entitlements
  + compute one projection revision + durable sync
```

If current term already ended, start is `now` under existing renewal policy. Upgrade is an immediate new term transition and requires explicit Add-on reselection; captured incompatible lines enter remediation instead of silent loss.

### Reset expiry

1. On term activation, cycle policy creates current epoch and planned UTC boundary.
2. Due scheduler transactionally claims `(termId,ordinal)` and closes it once.
3. It moves matching active entitlements to `EXPIRING`, creates next epoch, recomputes projection and work.
4. `user.traffic_reset` is stored as observed event. If it matches/delivers after due boundary, it triggers the same idempotent reconcile; before boundary it changes no commercial state.
5. `UNTIL_SUBSCRIPTION_END` ignores reset epochs but expires at term end.

## D-5. Rezeis and Reiwa contracts

### Contract evolution policy

Use additive versioned DTOs during deployment. Rezeis accepts legacy direct checkout temporarily but lifetime is read from authoritative catalog; new clients send `contractVersion: 2` and idempotency key. Reiwa validates upstream responses with Zod instead of `unknown`. Errors use stable machine codes plus correlation ID; no existence-sensitive leakage.

### Catalog eligibility

`GET /api/internal/add-ons/subscriptions/:subscriptionId?contractVersion=2`

Response:

```ts
{
  contractVersion: 2;
  availability: 'AVAILABLE' | 'EMPTY' | 'UPSTREAM_UNAVAILABLE';
  target: { subscriptionId: string; termId: string; planId: string };
  addOns: Array<{
    id: string; revision: number; name: string; description: string | null;
    type: 'EXTRA_TRAFFIC' | 'EXTRA_DEVICES'; value: number;
    lifetime: 'UNTIL_NEXT_RESET' | 'UNTIL_SUBSCRIPTION_END';
    eligibility: { eligible: true; activation: 'NOW' | 'TERM_START'; expiresAt: string; explanationCode: string };
    prices: Array<{ currency: string; price: string }>;
  }>;
}
```

Eligibility must be subscription/term-specific, not only plan-specific. Existing plan endpoint remains during transition but must not power new checkout authority.

### Direct checkout

`POST /api/internal/add-ons/purchase`

Add fields: `contractVersion:2`, `idempotencyKey`, optional expected `addOnRevision`. Quantity is absent/fixed to 1. Response is typed `InternalPaymentCheckoutInterface` plus `activationState` and `supportReference`.

Stable errors include:

- `ADDON_INELIGIBLE_STATUS`, `ADDON_INELIGIBLE_UNLIMITED_TRAFFIC`, `...UNLIMITED_DEVICES`, `...NO_RESET`, `...RESET_CAPABILITY_DISABLED`, `...PLAN`;
- `ADDON_PRICE_UNAVAILABLE`;
- `IDEMPOTENCY_KEY_CONFLICT`, `PROVIDER_OUTCOME_UNKNOWN`;
- `ADDON_CAPTURED_REMEDIATION_REQUIRED` only in status/operator contracts, not before payment.

### Renewal

Each renewal selection adds optional `addOns: [{addOnId, expectedRevision}]` to the subscription line. Server snapshots all product/money/term fields and hashes canonical JSON with stable key ordering. Draft equality is fingerprint equality, not total equality.

### Entitlement summary/status

Subscription consumer response gains additive:

```ts
{
  limits: {
    traffic: { base: string | null; addOn: string; effective: string | null };
    devices: { base: number | null; addOn: number; effective: number | null };
  };
  addOnEntitlements: Array<{
    id: string; name: string; type: string; value: number;
    lifetime: string; state: string;
    activatesAt: string; expiresAt: string;
    provisioning: 'PENDING'|'APPLIED'|'REMEDIATION_REQUIRED';
  }>;
}
```

Internal/admin status has richer drift/job/incident data; subscriber response excludes operator details and raw HWIDs.

### Authorization/idempotency matrix

| Contract | Auth/authorization | Validation | Idempotency/audit |
|---|---|---|---|
| Admin catalog | Admin JWT + `add_ons` RBAC | DTO + plan/currency/value checks | audit actor/reason/revision |
| Catalog/summary | verified Reiwa internal auth + bound user | ownership, term | read correlation only |
| Checkout/renewal | internal auth + canonical user ownership | eligibility, Decimal price, fingerprint | client/provider/webhook/line layers |
| Operator retry/reversal/plan approval | dedicated RBAC permissions | state/precondition/reason | command key + immutable audit |
| Remnawave webhook | existing signature/internal policy | normalized schema/event ID | inbox dedup, observed only |

## D-6. Reset policy and Remnawave capability adapter

### Cycle policy

Implement a pure `ResetCyclePolicy` returning `{epochId, startsAt, plannedEndsAt}` from strategy, UTC anchor and reference instant. No business logic derives expiry from enum names or `lastTrafficResetAt`.

- `NO_RESET`: no boundary; temporary-next-reset ineligible.
- `DAY/WEEK/MONTH/MONTH_ROLLING`: each has frozen UTC fixtures including month length/leap year/boundary equality.
- Each strategy has capability state `DISABLED|SHADOW_VERIFIED|ENABLED`; enable only after staging observations match both supported panel versions.
- DST is irrelevant because policy uses UTC instants.

### Strict adapter outcomes

Paid/destructive adapter methods do not reuse best-effort UI methods. They return/throw normalized outcomes:

```text
ok(value, detectedVersion) | notFound | unsupported | unavailable(retryAfter?) | invalidContract(details)
```

2.7.4/2.8.0 wire drift remains inside mapper. User PATCH uses UUID in body; device cleanup ignores row owner fields and uses request-context UUID.

### Desired-state write

1. Acquire per-subscription distributed/DB serialization key.
2. Reread projection and deletion status.
3. If job revision < desired revision, mark `SUPERSEDED`.
4. Map canonical unlimited to upstream zero and PATCH absolute latest limits.
5. Strictly read user back; compare desired limits.
6. Store observed state/drift; advance applied revision only on equality.
7. Retry transient outcomes; incident on terminal/age threshold.

## D-7. Reliability, concurrency and device saga

### Transactional consistency

Domain mutations run in a short PostgreSQL transaction. No provider/Remnawave HTTP call occurs inside it. Transaction includes lifecycle transition, projection revision and durable work row. Queue enqueue is recoverable from pending DB rows.

### Serialization/coalescing

BullMQ job IDs remain per durable row, but execution also serializes by subscription aggregate. Workers always reread latest desired state. UPDATEs coalesce; DELETE supersedes all writes. Optimistic versions/conditional updates prevent double lifecycle claims.

### Retry policy

Use existing shared queue conventions: bounded exponential backoff + jitter, attempt/error class persisted, `429` honors retry-after where available. Sweeper covers PENDING/RUNNING leases and FAILED CREATE/UPDATE/DELETE/cleanup, not CREATE alone. Terminal contract/auth failures alert without hot-looping.

### Device reduction saga

1. After desired device limit decreases, strict-read all devices.
2. Validate envelope, total consistency, unique nonempty HWID and every `createdAt`.
3. Calculate overage; if none, mark verified.
4. Sort UTC timestamps descending, tie canonical HWID descending; persist immutable target list and source projection revision before deletion.
5. Exact-delete one planned target; strict-read and mark progress. A missing planned target is idempotent only when read-back proves absence.
6. Before each further delete, check subscription not deleted, desired revision not superseded and current overage still positive. Never delete more than required after concurrent user changes.
7. Final strict read must prove count <= current desired finite limit. If desired limit changed, supersede/replan safely; if source data invalid, block before mutation.

Partial success does not recalculate arbitrary victims. It resumes remaining persisted targets or requires a new plan after explicit supersession.

## D-8. Threat model, operator controls and observability

### Trust boundary

```text
Browser/TWA (untrusted fields)
  → Reiwa verified session/Telegram binding
  → authenticated internal Rezeis request
  → Rezeis ownership/RBAC + price/eligibility authority
  → DB commercial transaction
  → signed/authenticated provider and Remnawave boundaries
```

### Threats and controls

| Threat | Control | Verification |
|---|---|---|
| forged subscription/add-on/price | Rezeis ownership, catalog revision and Decimal price lookup | negative API tests |
| duplicate payment/grant | four-layer keys/unique source line | replay/concurrency tests |
| free grant abuse | key scope, eligibility and rate limits | abuse tests |
| stale external overwrite | aggregate serialization/revision/read-back | permutation tests |
| wrong HWID deletion | strict full validation/persisted plan/exact delete | failure-injection contracts |
| unauthorized remediation | distinct RBAC permissions/reason/audit | controller tests |
| PII/secret leakage | redaction, no HWID metric labels/provider payload logs | log snapshot/security tests |

### Operator commands

Read view: ledger, term, projection, normalized observed state, jobs/incidents. Mutations: retry sync, force reconcile, acknowledge incident, approve blocked plan, schedule compensating reversal/waiver. Each requires command idempotency key, reason, actor, correlation ID and immutable before/after event. No direct SQL-like ledger editing in API/UI.

### Metrics/SLO

Counters and age histograms:

- checkout/draft/provider outcome;
- payment captured → entitlement committed latency;
- committed → applied+verified latency;
- projection pending/applied/superseded/failed/drifted;
- due/expired entitlements and reset epoch lag;
- device plan blocked/partial/completed;
- incident backlog by bounded kind/severity.

Initial configurable objective: 99% applied+verified ≤5 minutes; alert any paid item >15 minutes. IDs belong in logs/traces, not metric labels. No raw HWID, token, init data or provider payload.

### Analytics

Stats join explicit entitlement/source line, not generic `ADDITIONAL`. Separate captured, committed, verified, remediation, expiry and operator reversal. Legacy ambiguous transactions are `UNKNOWN_ADDITIONAL`.

## D-9. UX and accessibility

### Reiwa

- Catalog has loading, available, true-empty, unavailable/offline and retry states.
- Review step precedes checkout and shows target, exact gateway currency price, value, lifetime, expiry date/rule and non-recurring notice.
- Device Add-on explains newest-device removal on future reduction.
- Submission uses one idempotency key per intent, disabled/busy control and resumable payment result.
- Subscription/renewal surfaces show base + active Add-on = effective, scheduled/active/expiring/remediation state.
- Focus moves/restores intentionally; `aria-busy`/live regions announce status; keyboard/mobile/reduced-motion paths are preserved.

### Admin

Catalog form includes lifetime/default/archive. Detail/reconciliation view shows immutable snapshots, projection revisions, drift, jobs/incidents and permission-gated actions. HWID display is restricted/redacted; no automatic victim selection in browser.

## D-10. Migration, deployment and rollback

### Additive migration

1. Add enums/models/nullable relations/indexes and catalog lifetime default.
2. Normalize new-domain unlimited as null; do not rewrite Remnawave.
3. Create one grandfathered active `SubscriptionTerm` per existing non-deleted subscription from current local effective limits, with cutover metadata.
4. Do **not** convert historical top-ups/rewards into active temporary entitlements and do not subtract them.
5. Create shadow projection equal to current local limits; report mismatches/ambiguous rows.
6. Only subscriptions with equality may enter active projection mode.

Migration scripts must be rerunnable/idempotent by cutover version and expose dry-run counts; production migration deploy is a later operator action, not part of this spec.

### Staged rollout flags

1. `catalog_v2`: lifetime and typed eligibility responses, no new lifecycle writes.
2. `entitlement_shadow`: terms/ledger-ready schema and shadow projection; legacy fulfillment still authoritative.
3. `entitlement_direct_purchase`: new direct checkout lines commit ledger/projection.
4. `projection_sync`: versioned desired writes/read-back.
5. `reset_expiry_<strategy>` separately after parity.
6. `renewal_addons`: scheduled renewal composition.
7. `device_cleanup_auto`: last, after strict adapter/saga observation; prior mode creates operator-reviewed plans only.

### Rollback

Disable admission and workers in reverse order. Do not delete ledger/terms/projections. For already admitted lines, keep reconciliation workers or operator runbook active; rollback must not abandon paid service. Legacy compatibility columns continue to mirror current effective projection, so old readers remain safe. Never copy observed upstream values into baseline.

### Recovery/runbook triggers

- captured line without entitlement;
- projection pending/failed over SLO;
- observed drift;
- reset scheduler lag;
- invalid device contract/partial cleanup;
- refund/chargeback incident;
- migration shadow mismatch.

Each trigger has inspect → retry/reconcile → compensating decision → audit path.

## D-11. Testing and verification strategy

### Unit/property

- canonical unlimited and checked aggregation;
- entitlement state transition legality/idempotency;
- reset policy UTC fixtures, leap/month boundaries and webhook ordering;
- canonical fingerprint stability/conflict;
- HWID validation/sort/immutable plan;
- drift classification and redaction.

### PostgreSQL integration/concurrency

Use real PostgreSQL for unique source line, concurrent distinct purchases, duplicate capture, scheduler/webhook race, renewal/expiry transaction, optimistic revision, stale worker and delete/payment races. Mock-only tests are insufficient for these invariants.

### Contract

- Rezeis controller DTO/error snapshots and Reiwa Zod consumers;
- Remnawave OpenAPI-derived 2.7.4/2.8.0 user/HWID fixtures;
- strict outcomes for 200/404/401/403/429/5xx/timeout/malformed envelopes;
- exact PATCH/delete paths/bodies and postcondition read-back;
- old/new Reiwa additive deployment compatibility.

### Failure injection

Crash after provider create, capture, entitlement insert, projection insert, DB commit before enqueue, PATCH before read-back, each HWID delete and final verification. Recovery must be deterministic and not duplicate value/deletion.

### UI/E2E/accessibility

Direct paid/free, delayed activation, permanent failure, early renewal, same-total different composition, unsupported reset, unlimited resources, outage vs empty, offline resume, keyboard/focus/live announcements/mobile.

### Canonical commands during implementation

Rezeis backend:

```bash
npm run prisma:generate
npm run typecheck
node --require ts-node/register --test test/<focused>.spec.ts
npm test
npm run lint
npm run build
```

Rezeis admin web (from `rezeis-admin/web`): use package-declared focused Vitest/typecheck/build, then full declared gates.

Reiwa:

```bash
npm run check
npm test
npm run test:pbt
npm run build
```

Reiwa web:

```bash
npm run typecheck
npm run build
```

Add a web test runner only if implementation introduces it through a separately reviewed dependency change; otherwise component behavior needs existing/repo-approved browser harness or Reiwa root contract/E2E coverage.

## D-12. Alternatives and decisions

| Decision | Rejected alternative | Rationale / consequence |
|---|---|---|
| Separate term/ledger/projection/observed layers | keep increment columns + expiry subtraction | subtraction loses provenance and races renewal/rewards |
| Grandfather current effective baseline | historical transaction subtraction | lifetime/status/reward composition unknowable |
| Local planned reset epoch | expire on any webhook/last reset | manual reset would revoke paid value |
| Absolute latest revision + read-back | apply deltas or trust queue order | Remnawave contract is absolute; queue completion order is unsafe |
| Persisted HWID saga | best-effort sorted loop/delete-all | partial failure/retry could delete different or too many devices |
| Term-scoped one-time Add-ons | extend until final subscription cancellation | would make renewal silently recurring/free |
| v1 operator refund incident | automatic clawback | current payment state machine treats completed as terminal |
| quantity=1 lines | cart quantities | preserves current UX and reduces idempotency/receipt complexity |

## D-13. Requirement traceability

| Requirement | Design sections | Tasks | Verification |
|---|---|---|---|
| R-001 | D-3/D-5/D-8 | T-001/T-006/T-013 | catalog schema/API/admin tests |
| R-002 | D-3/D-4/D-5/D-6 | T-002/T-006/T-014 | eligibility/unlimited/reset capability |
| R-003 | D-3/D-4 | T-001/T-003/T-004 | DB invariants/property tests |
| R-004 | D-3/D-4/D-7 | T-003/T-004/T-009 | atomic outbox/revision tests |
| R-005 | D-4/D-5/D-7 | T-005/T-007/T-009/T-015 | idempotency/crash/sweeper tests |
| R-006 | D-3/D-4/D-7/D-8 | T-003/T-005/T-011/T-013 | state/recovery/audit tests |
| R-007 | D-4/D-6/D-11 | T-002/T-008/T-016 | cycle fixtures/races |
| R-008 | D-4/D-5 | T-007/T-008/T-015 | renewal/upgrade integration/E2E |
| R-009 | D-6/D-7 | T-009/T-010/T-016 | stale/retry/read-back tests |
| R-010 | D-3/D-6/D-7 | T-010/T-011/T-016 | strict adapter/saga failure injection |
| R-011 | D-5/D-9 | T-014/T-015/T-017 | contract/UI/a11y/E2E |
| R-012 | D-8/D-9 | T-013/T-017 | RBAC/audit/redaction |
| R-013 | D-8 | T-012/T-017 | metrics/SLO/log assertions |
| R-014 | D-5/D-6 | T-006/T-010/T-014/T-016 | cross-repo/vendor contracts |
| R-015 | D-3/D-10 | T-001/T-004/T-018 | dry-run/shadow/rollback |
| R-016 | D-5/D-8 | T-005/T-013/T-014/T-017 | authz/rate/security |
| R-017 | D-8 | T-012 | analytics fixtures |
| R-018 | D-10/D-11 | T-016/T-017/T-018 | staged complete gates |

## D-14. Design gate

- **Feasible:** yes.
- **Unresolved blockers/majors:** none.
- **Unverified bounded assumption:** exact calendar parity per Remnawave strategy; protected by disabled capability until staging verification.
- **Threat model/payment/provisioning/admin/contract gates:** covered.
- **Migration/rollback/reconciliation:** covered.
- **Approved for task breakdown:** yes.
- **Approved for implementation:** no; explicit user approval still required.
