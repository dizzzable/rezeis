---
spec_version: 1
created_at: 2026-07-11T20:22:00+03:00
workflow: requirements-first
status: ready-for-review
run_id: 20260711-200606-9e4bf3
---

# Временные Add-on entitlements подписки — требования

## 1. Scope

- **Цель:** превратить Add-ons из постоянного арифметического top-up в одноразовые стекуемые коммерческие entitlements для одной подписки с явным сроком, восстановимым fulfillment, корректным renewal и безопасной Remnawave-проекцией.
- **Акторы:** подписчик Reiwa; администратор/оператор Rezeis; Reiwa BFF/SPA; Rezeis API/workers; payment gateway; Remnawave 2.7.4/2.8.0.
- **In scope:** каталог/lifetime; direct и renewal checkout; immutable ledger; activation/expiry; baseline/effective projection; reset/term semantics; payment/sync recovery; HWID cleanup; Reiwa/admin UX; migration; audit/metrics/tests.
- **Out of scope:** recurring Add-ons; автоматическое наследование в новый term; автоматический post-completion refund/chargeback clawback в v1; изменение device names/numbering; `rezeis-subpage`; релиз/деплой.
- **Success:** каждая новая оплаченная строка либо доказанно применена в Remnawave, либо находится в видимом retry/remediation state; effective limits всегда воспроизводимы из Rezeis; ни manual reset, ни stale job, ни malformed HWID data не отнимают услугу ошибочно.

## 2. Термины

- **Каталожная опция:** админ-конфигурируемый Add-on с type/value/lifetime/prices/applicability.
- **Service term:** один оплаченный период подписки с immutable start/end и plan baseline.
- **Entitlement:** immutable purchase/grant snapshot плюс append-only lifecycle transitions для одной строки покупки и одного term.
- **Baseline:** конечные или unlimited лимиты service term без новых lifetime-managed Add-ons.
- **Desired projection:** baseline плюс сумма `ACTIVE` entitlements.
- **Observed state:** последнее строго прочитанное состояние Remnawave; не коммерческая истина.
- **Planned reset boundary:** локально сохранённая естественная граница traffic cycle; manual/early reset её не закрывает.
- **Stacking:** несколько отдельных покупок одной/разных опций суммируются; quantity одной checkout-строки в v1 равна `1`.

## 3. Evidence and assumptions

| ID | Type | Statement | Source / confidence |
|---|---|---|---|
| E-001 | evidence | Текущий fulfillment прямо increment-ит subscription limits; ledger отсутствует. | `research/01-codebase.md`; high |
| E-002 | evidence | Renewal/upgrade/admin paths перезаписывают те же limits. | `_runs/.../research-handoff.md`, CODE-002; high |
| E-003 | evidence | Completed payment может остаться без применённой услуги; free path не имеет webhook recovery. | CODE-003; high |
| E-004 | evidence | Device unlimited sentinel может стать finite после Add-on increment. | CODE-005; high |
| E-005 | evidence | Remnawave 2.7.4/2.8.0 имеют stable update/list/exact-delete operations, но no `nextTrafficResetAt`. | `research/02-domain-and-external.md`; high |
| E-006 | evidence | Strict destructive reads отсутствуют; failures collapse в empty/null. | CONTRACT-004; high |
| E-007 | evidence | Historical lifetime/status нельзя достоверно восстановить. | MIG-001; high |
| E-008 | decision | Lifetime per option: `UNTIL_NEXT_RESET` или `UNTIL_SUBSCRIPTION_END`, default first. | accepted product decision |
| E-009 | decision | Add-ons one-time, stackable, specific subscription, no auto-recurring; renewal is explicit reselection. | accepted product decision |
| E-010 | decision | Early/manual reset clears usage only and never expires entitlement. | accepted product decision |
| E-011 | bounded assumption | Local cycle policy uses UTC fixtures and is disabled per strategy until staging parity is proven. | vendor calendar undocumented |
| E-012 | bounded scope | v1 refund/chargeback after completion creates operator incident, not automatic entitlement reversal. | payment state-machine limitation |

## 4. Functional requirements

### R-001 — Управляемая каталожная политика lifetime

- **Priority:** must
- **Value:** оператор управляет сроком продукта без изменения кода, пользователь получает однозначное предложение.
- **Source:** E-008, E-009.
- **EARS:** `WHEN администратор создаёт или изменяет Add-on, THE system SHALL валидировать и сохранять type, positive value, lifetime, applicability, active/archive state и decimal prices, применяя UNTIL_NEXT_RESET только как default для отсутствующего legacy input.`
- **Acceptance criteria:**
  - **AC-R001-1:** create/update accepts only `EXTRA_TRAFFIC|EXTRA_DEVICES` and `UNTIL_NEXT_RESET|UNTIL_SUBSCRIPTION_END`; `value > 0`; at most one price per currency.
  - **AC-R001-2:** missing lifetime on migrated catalog rows becomes `UNTIL_NEXT_RESET`; new API responses always include lifetime.
  - **AC-R001-3:** option with purchase/entitlement references is archived/deactivated, not hard-deleted; historical snapshots remain readable.
  - **AC-R001-4:** admin CRUD keeps current `add_ons` RBAC and records actor/reason/before/after audit.
- **Error/boundary:** invalid enum/value/duplicate price/unknown plan ID returns stable validation error and creates no mutation.
- **Dependencies:** R-002, R-014.
- **Traceability:** D-3, D-5, D-8; T-001, T-006, T-013.

### R-002 — Authoritative eligibility and unlimited safety

- **Priority:** must
- **Value:** нельзя продать бессмысленное дополнение или повредить unlimited.
- **Source:** E-004, E-005.
- **EARS:** `IF target resource baseline is unlimited, subscription/term is not eligible, reset policy cannot supply a verified boundary, or option is inapplicable, THEN THE system SHALL omit the option from authoritative catalog eligibility and reject direct checkout before creating a transaction.`
- **Acceptance criteria:**
  - **AC-R002-1:** traffic and devices each use one canonical domain representation for unlimited; arithmetic never applies to sentinels.
  - **AC-R002-2:** `EXTRA_TRAFFIC` is rejected for unlimited traffic; `EXTRA_DEVICES` for unlimited devices at list, checkout and fulfillment/revalidation layers.
  - **AC-R002-3:** direct purchase requires ownership and `ACTIVE|LIMITED` current term; `EXPIRED|DISABLED|DELETED` are rejected.
  - **AC-R002-4:** `UNTIL_NEXT_RESET` is rejected for `NO_RESET` or any reset strategy whose local parity capability is disabled.
  - **AC-R002-5:** Reiwa hiding is UX only; a crafted request receives `ADDON_INELIGIBLE_*` without payment creation.
- **Error/boundary:** plan/add-on/status changes before capture follow R-005 remediation policy.
- **Dependencies:** R-001, R-008.
- **Traceability:** D-4, D-5, D-6; T-002, T-006, T-014.

### R-003 — Immutable service term baseline и entitlement ledger

- **Priority:** must
- **Value:** лимит объясним, воспроизводим и не теряется при renewal/upgrade.
- **Source:** E-001, E-002, E-007.
- **EARS:** `WHEN a new Add-on purchase is committed, THE system SHALL create at most one immutable entitlement for its source line and derive effective limits from the target term baseline plus all ACTIVE entitlements without mutating entitlement history.`
- **Acceptance criteria:**
  - **AC-R003-1:** each service term snapshots plan ID/revision, start/end, base traffic/device limits, reset strategy/anchor and generation ID.
  - **AC-R003-2:** entitlement snapshots source transaction/line, catalog revision/ID/name, type, value, quantity=1, lifetime, target subscription/term, money/currency, purchased/activation/expiry boundaries.
  - **AC-R003-3:** unique source line prevents duplicate entitlement; separate transactions create separate stackable rows.
  - **AC-R003-4:** projection formula is deterministic/idempotent; unlimited is absorbing; expiring one row does not alter neighbors.
  - **AC-R003-5:** ledger/financial history survives catalog archive and subscription deletion.
- **Error/boundary:** unknown baseline enters `RECONCILIATION_REQUIRED`; system never infers it from observed Remnawave effective state.
- **Dependencies:** R-001, R-004.
- **Traceability:** D-3, D-4; T-001, T-003, T-004.

### R-004 — Versioned desired projection

- **Priority:** must
- **Value:** Rezeis остаётся source of truth, а external state сходится к последней покупке/expiry.
- **Source:** E-001, E-002.
- **EARS:** `WHEN baseline or entitlement lifecycle changes, THE system SHALL atomically recompute a materialized desired projection, increment its monotonic revision, and persist durable synchronization work in the same database transaction.`
- **Acceptance criteria:**
  - **AC-R004-1:** projection stores baseline contributions, active sums, desired effective limits, desired revision and last applied/observed metadata.
  - **AC-R004-2:** no commercial commit can exist without corresponding durable work/outbox record.
  - **AC-R004-3:** Remnawave read/webhook updates observed state only, never baseline/ledger.
  - **AC-R004-4:** repeated recompute with unchanged ledger is value-idempotent and does not double-count.
- **Error/boundary:** transaction rollback leaves neither partial entitlement nor orphan projection mutation.
- **Dependencies:** R-003.
- **Traceability:** D-3, D-4, D-7; T-003, T-004, T-009.

### R-005 — Four-layer checkout/fulfillment idempotency and paid recovery

- **Priority:** must
- **Value:** retries не создают двойную оплату, captured payment не исчезает без услуги.
- **Source:** E-003, CODE-004.
- **EARS:** `WHEN a direct or renewal Add-on checkout is retried, paid, replayed or interrupted, THE system SHALL independently enforce request, provider-call, webhook-event and fulfillment idempotency and converge every captured line to committed entitlement or explicit remediation.`
- **Acceptance criteria:**
  - **AC-R005-1:** client idempotency key + canonical full line-item fingerprint returns the same unexpired draft/provider checkout for equivalent requests and rejects key reuse with different composition.
  - **AC-R005-2:** provider create uses supported idempotency/reference; unknown outcome is reconciled before another checkout is allowed.
  - **AC-R005-3:** webhook inbox dedup remains; unique source line/fulfillment claim prevents duplicate entitlement.
  - **AC-R005-4:** zero-price completion, entitlement commit, projection and outbox are one DB transaction.
  - **AC-R005-5:** a sweeper retries `captured/completed but entitlement-not-committed` and stalled projection states, including providerless rows.
  - **AC-R005-6:** if eligibility changes after capture, the immutable purchased snapshot is honored when safe; otherwise state becomes `REMEDIATION_REQUIRED` with no silent no-op and operator compensation path.
- **Error/boundary:** user sees paid/pending activation/support reference; transaction `fulfilledAt` alone is not upstream delivery proof.
- **Dependencies:** R-003, R-004, R-006.
- **Traceability:** D-4, D-5, D-7; T-005, T-007, T-009, T-015.

### R-006 — Explicit lifecycle states and terminal semantics

- **Priority:** must
- **Value:** каждый paid entitlement имеет объяснимое состояние и recoverable transition.
- **Source:** critic findings.
- **EARS:** `WHEN an entitlement is purchased, activated, reaches its boundary, is deleted with its subscription, or fails provisioning/cleanup, THE system SHALL perform an idempotent audited transition among scheduled, active, expiry/cleanup, terminal and remediation states.`
- **Acceptance criteria:**
  - **AC-R006-1:** at minimum supports `PENDING_ACTIVATION`, `ACTIVE`, `EXPIRING`, `EXPIRED`, `REVERSED`, `REMEDIATION_REQUIRED`; device cleanup has explicit pending/blocked/applied progress.
  - **AC-R006-2:** activation and expiry each occur at most once; duplicate scheduler/webhook/job delivery is harmless.
  - **AC-R006-3:** subscription `DELETED` terminates pending/active entitlements without deleting history and avoids redundant HWID cleanup after whole-profile deletion.
  - **AC-R006-4:** post-completion refund/chargeback creates immutable incident/audit and operator action in v1; no automatic hidden clawback.
- **Error/boundary:** illegal state transitions are rejected, logged without PII, and leave previous state intact.
- **Dependencies:** R-003, R-005.
- **Traceability:** D-4, D-7, D-8; T-003, T-005, T-011, T-013.

### R-007 — Planned reset epoch

- **Priority:** must
- **Value:** temporary Add-on survives manual reset but ends on the intended commercial cycle.
- **Source:** E-005, E-010, E-011.
- **EARS:** `WHEN a term with a supported reset strategy becomes active, THE system SHALL persist a local UTC reset epoch and next planned boundary, and SHALL expire UNTIL_NEXT_RESET entitlements only when that stored epoch closes.`
- **Acceptance criteria:**
  - **AC-R007-1:** cycle policy specifies strategy, timezone=`UTC`, anchor, DST-independent rule, current epoch ID and planned boundary.
  - **AC-R007-2:** manual/early reset updates usage/observed event only and does not change epoch or expiry.
  - **AC-R007-3:** scheduler closes boundary without webhook; matching webhook may accelerate reconcile; duplicate/out-of-order webhook cannot close a later epoch.
  - **AC-R007-4:** entitlement snapshots target expiry epoch/boundary and later subscription extension cannot move it.
  - **AC-R007-5:** DAY/WEEK/MONTH/MONTH_ROLLING are enabled separately only after fixture parity against both supported Remnawave versions; NO_RESET remains ineligible.
- **Error/boundary:** ambiguous vendor event is retained as observation and triggers reconcile, not expiry guess.
- **Dependencies:** R-003, R-008.
- **Traceability:** D-4, D-6, D-11; T-002, T-008, T-016.

### R-008 — Service-term transition, renewal and upgrade

- **Priority:** must
- **Value:** one-time Add-ons не продлеваются бесплатно и не начинают срок до оплаченного периода.
- **Source:** E-002, E-009.
- **EARS:** `WHEN a renewal or upgrade creates a new service term, THE system SHALL atomically close the prior term-scoped entitlements, establish the new baseline, and activate only Add-ons explicitly purchased for the new term at that term's start.`
- **Acceptance criteria:**
  - **AC-R008-1:** both lifetime policies end no later than their snapshotted target term end; neither auto-carries into a subsequent term.
  - **AC-R008-2:** early-renewal Add-ons stay `PENDING_ACTIVATION` until scheduled term start; purchase time does not consume lifetime.
  - **AC-R008-3:** renewal checkout offers eligible Add-ons as explicit unchecked selections; no recurring attachment.
  - **AC-R008-4:** full fingerprint includes subscription, target plan/duration/term, every Add-on ID/revision/type/value/lifetime/quantity, price/currency and channel/gateway.
  - **AC-R008-5:** all renewal lines, term transition, entitlements, projection and outbox commit atomically or remain retryable paid-undelivered.
  - **AC-R008-6:** upgrade starts a new term under the same explicit reselection rule; incompatible captured lines enter remediation.
- **Error/boundary:** same total with different composition never reuses another draft.
- **Dependencies:** R-001–R-007.
- **Traceability:** D-4, D-5; T-007, T-008, T-015.

### R-009 — Convergent Remnawave projection

- **Priority:** must
- **Value:** stale jobs и transient failures не откатывают оплаченный лимит.
- **Source:** E-005, sync findings.
- **EARS:** `WHEN desired projection revision changes, THE system SHALL serialize or coalesce work per subscription, reread the latest desired state immediately before an absolute Remnawave write, skip superseded jobs, and strictly verify the resulting upstream state.`
- **Acceptance criteria:**
  - **AC-R009-1:** at most one upstream mutation per subscription executes concurrently; DELETE has defined priority over UPDATE/cleanup.
  - **AC-R009-2:** stale job is `SUPERSEDED` without writing its old payload.
  - **AC-R009-3:** CREATE/UPDATE/expiry/cleanup failures all receive bounded exponential retry + jitter and durable sweeper recovery.
  - **AC-R009-4:** write response and strict read-back are schema-validated; applied revision advances only when desired limits match.
  - **AC-R009-5:** timeout/401/403/429/5xx/malformed response never becomes success/not-found.
- **Error/boundary:** persistent drift becomes remediation alert; Rezeis desired state remains unchanged.
- **Dependencies:** R-004, R-014.
- **Traceability:** D-6, D-7; T-009, T-010, T-016.

### R-010 — Fail-closed HWID reduction saga

- **Priority:** must
- **Value:** снижение device entitlement удаляет только необходимое число newest devices и никогда не угадывает.
- **Source:** E-005, E-006.
- **EARS:** `WHEN expiration lowers the finite effective device limit below the authoritative HWID count, THE system SHALL persist and execute a deterministic exact-device removal plan using validated createdAt and canonical hwid, then verify the postcondition before declaring reconciliation complete.`
- **Acceptance criteria:**
  - **AC-R010-1:** strict adapter returns `ok|notFound|unsupported|unavailable|invalidContract`; all rows must have unique nonempty HWID and valid finite ISO `createdAt` before any delete.
  - **AC-R010-2:** overage N selects `createdAt DESC`, then canonical `hwid DESC`; plan IDs/timestamps are immutable and exclude UI order/name/platform/updatedAt/IP.
  - **AC-R010-3:** only exact `/api/hwid/devices/delete {userUuid,hwid}` is used; never delete-all.
  - **AC-R010-4:** retry resumes the persisted plan, recognizes already-absent targets idempotently, reads back after each/at completion, and handles concurrent add/delete without removing more than required.
  - **AC-R010-5:** invalid/missing/duplicate data or upstream unavailability causes `DEVICE_REDUCTION_BLOCKED`, no destructive mutation, operator/user visibility.
  - **AC-R010-6:** success requires remaining valid count `<= desired effectiveDeviceLimit` and desired limit applied.
- **Error/boundary:** whole-profile deletion supersedes this saga.
- **Dependencies:** R-006, R-009.
- **Traceability:** D-3, D-6, D-7; T-010, T-011, T-016.

### R-011 — Reiwa catalog, direct purchase and status UX

- **Priority:** must
- **Value:** пользователь до оплаты понимает цену, срок, target и последствия; после оплаты видит реальный provisioning state.
- **Source:** contract/UX findings.
- **EARS:** `WHEN a subscriber browses, reviews or purchases an Add-on, THE system SHALL present server-authoritative eligibility, gateway-currency price, lifetime/boundary, non-recurring notice, target subscription and activation status through accessible recoverable UI states.`
- **Acceptance criteria:**
  - **AC-R011-1:** catalog distinguishes true empty from upstream unavailable and filters according to backend eligibility metadata.
  - **AC-R011-2:** review/confirm step shows exact option/value, lifetime, known date or honest calendar rule, gateway-specific decimal price, target term/subscription and device-reduction consequence.
  - **AC-R011-3:** UI prevents accidental duplicate submit, sends idempotency key, and displays paid-pending/applied/remediation with support reference.
  - **AC-R011-4:** subscription views expose base/effective limit, active/scheduled entitlements, expiry and cleanup state without leaking operator-only details.
  - **AC-R011-5:** keyboard/focus order, focus restoration, `aria-busy`, live success/error, readable labels, mobile/offline/retry and reduced-motion behavior are tested.
- **Error/boundary:** error does not silently redirect or represent outage as no products.
- **Dependencies:** R-002, R-005, R-014.
- **Traceability:** D-5, D-9; T-014, T-015, T-017.

### R-012 — Operator reconciliation and immutable audit

- **Priority:** must
- **Value:** paid-service incidents and destructive operations are diagnosable and recoverable under least privilege.
- **Source:** critic/ops findings.
- **EARS:** `WHEN an entitlement, projection, refund incident or device cleanup requires intervention, THE system SHALL expose least-privilege operator actions with mandatory reason, correlation ID, immutable before/after audit and no direct ledger editing.`
- **Acceptance criteria:**
  - **AC-R012-1:** operator can inspect ledger/projection/observed drift, retry, force reconcile, acknowledge incident, schedule explicit reversal/waiver and approve blocked removal plan through distinct permissions.
  - **AC-R012-2:** every mutation records actor, permission, reason, target IDs, prior/new state, result, correlation ID; secrets and payment payloads excluded.
  - **AC-R012-3:** HWIDs are treated as restricted identifiers: absent from metrics/general logs, redacted or access-controlled in audit with retention policy.
  - **AC-R012-4:** immutable ledger rows are never edited/deleted; corrections are compensating transitions.
- **Error/boundary:** unauthorized actions return forbidden and create no mutation.
- **Dependencies:** R-006, R-010, R-013.
- **Traceability:** D-8, D-9; T-013, T-017.

## 5. Non-functional requirements

### R-013 — Observability and paid-service SLO

- **Priority:** must
- **Value:** captured-but-unapplied услуга обнаруживается до обращения пользователя.
- **Source:** E-003.
- **EARS:** `WHILE any paid entitlement is not upstream-applied and verified, THE system SHALL expose its age, stage and correlation identifiers in metrics/logs/operator views and alert when the configured activation SLO is exceeded.`
- **Acceptance criteria:**
  - **AC-R013-1:** metrics cover checkout created/captured, entitlement committed, projection pending/applied/superseded/failed, reset expiry, HWID cleanup and remediation backlog/age.
  - **AC-R013-2:** target SLO is configurable; initial rollout target is 99% applied+verified within 5 minutes, with alert on any item older than 15 minutes.
  - **AC-R013-3:** structured logs correlate payment/line/entitlement/subscription/projection/job without tokens, raw provider payloads, Telegram init data or full HWID.
  - **AC-R013-4:** dashboards separate financial completion, local entitlement commit and external verification.
- **Error/boundary:** metrics cardinality is bounded; PII is not used as label.
- **Dependencies:** R-005, R-009, R-012.
- **Traceability:** D-8; T-012, T-017.

### R-014 — Versioned producer/consumer contracts

- **Priority:** must
- **Value:** Rezeis/Reiwa и Remnawave версии не расходятся незаметно.
- **Source:** E-005, E-006.
- **EARS:** `WHEN entitlement APIs or Remnawave wire data are produced or consumed, THE system SHALL validate versioned DTOs/envelopes at the boundary and normalize vendor-version drift behind a capability adapter.`
- **Acceptance criteria:**
  - **AC-R014-1:** Rezeis owns typed contracts for catalog eligibility, checkout/renewal composition, entitlement summary/status and errors; Reiwa admin client is not `unknown`.
  - **AC-R014-2:** additive migration supports old Reiwa during deployment; unsupported contract version fails explicitly, not as empty catalog.
  - **AC-R014-3:** adapter fixtures cover 2.7.4 `userUuid` and 2.8.0 `userId/requestIp`, both nullable encodings/envelopes and stable exact-delete request.
  - **AC-R014-4:** webhook event drift remains adapter-local; business logic receives normalized observed reset/HWID events with event identity/timestamp.
- **Error/boundary:** invalid contract is distinguishable from unavailable/notFound.
- **Dependencies:** R-001, R-009, R-010.
- **Traceability:** D-5, D-6; T-006, T-010, T-014, T-016.

### R-015 — Safe legacy migration and rollback

- **Priority:** must
- **Value:** rollout не снимает и не удваивает ранее оплаченные/выданные лимиты.
- **Source:** E-007.
- **EARS:** `WHEN entitlement lifecycle is enabled for an existing subscription, THE system SHALL grandfather its current local effective limits as a versioned commercial baseline and apply managed entitlements only to post-cutover checkout lines.`
- **Acceptance criteria:**
  - **AC-R015-1:** migration adds nullable/additive structures, records cutover version/time, normalizes unlimited representations and snapshots current local limits without Remnawave writes.
  - **AC-R015-2:** historical transactions remain financial provenance but are not activated/subtracted as temporary entitlements.
  - **AC-R015-3:** dry-run reports counts, finite/unlimited distributions, ambiguous rows and expected shadow projection equality before enablement.
  - **AC-R015-4:** shadow projection must equal existing local effective state for every migrated subscription before writes are enabled.
  - **AC-R015-5:** rollback disables new checkout/workers and restores legacy projection path without deleting ledger/history or treating effective as baseline.
- **Error/boundary:** mismatch blocks activation for affected subscription and creates reconciliation record.
- **Dependencies:** R-003, R-004.
- **Traceability:** D-3, D-10; T-001, T-004, T-018.

### R-016 — Security, privacy and abuse controls

- **Priority:** must
- **Value:** финансовые и destructive actions защищены server-side.
- **Source:** Rezeis quality gates.
- **EARS:** `WHEN any catalog, checkout, entitlement, reconciliation or HWID mutation is requested, THE system SHALL authenticate identity, authorize ownership/RBAC server-side, validate canonical input, rate-limit abuse-prone operations and audit accepted mutations.`
- **Acceptance criteria:**
  - **AC-R016-1:** Reiwa browser identity remains untrusted; existing verified session/Telegram identity binding is reused; subscription ownership is checked in Rezeis.
  - **AC-R016-2:** money remains Prisma Decimal/string across contracts; no binary-float arithmetic.
  - **AC-R016-3:** checkout/idempotency and operator endpoints have bounded rate/volume controls; zero-price repeat abuse is prevented.
  - **AC-R016-4:** provider webhook signature/auth and inbox dedup remain mandatory.
  - **AC-R016-5:** no new secret storage; provider/panel credentials never enter SPA/spec/logs.
- **Error/boundary:** auth/authz failure precedes existence-sensitive details where appropriate.
- **Dependencies:** R-005, R-012.
- **Traceability:** D-5, D-8; T-005, T-013, T-014, T-017.

### R-017 — Analytics correctness

- **Priority:** should
- **Value:** Add-on revenue и delivery health не смешиваются с generic `ADDITIONAL` purchases.
- **Source:** stats finding.
- **EARS:** `WHEN Add-on analytics are computed, THE system SHALL identify products through explicit Add-on line/entitlement relations and report financial, activation and remediation outcomes separately.`
- **Acceptance criteria:**
  - **AC-R017-1:** generic `PurchaseType.ADDITIONAL` alone is insufficient; ambiguous legacy rows are `UNKNOWN_ADDITIONAL`.
  - **AC-R017-2:** reports separate paid/captured, activated/applied, failed/remediation, expiry and operator reversal.
  - **AC-R017-3:** v1 refund incidents are visible but do not alter recognized totals automatically without defined accounting action.
- **Error/boundary:** archived catalog rows retain historical labels from immutable snapshots.
- **Dependencies:** R-003, R-006.
- **Traceability:** D-8; T-012.

### R-018 — Verification and rollout gates

- **Priority:** must
- **Value:** high-risk commercial/destructive behavior ships only after deterministic proof.
- **Source:** critic test matrix.
- **EARS:** `WHERE entitlement lifecycle is enabled, THE system SHALL pass unit, PostgreSQL integration/concurrency, cross-repo contract, Remnawave 2.7.4/2.8.0 fixture, migration, failure-injection, accessibility and end-to-end gates before traffic is admitted.`
- **Acceptance criteria:**
  - **AC-R018-1:** tests cover stacking, duplicate vs distinct payments, checkout/provider crash points, plan/status/unlimited races, early renewal, manual vs natural reset, stale sync, deletion races and refund incident.
  - **AC-R018-2:** HWID tests cover invalid/duplicate/equal timestamps, version drift, partial deletion/retry and all strict outcomes.
  - **AC-R018-3:** migration dry-run/shadow/rollback and no-write backfill are tested on representative finite/unlimited/legacy fixtures.
  - **AC-R018-4:** rollout flags separately gate catalog lifetime, new ledger writes, projection sync, reset expiry, renewal selection and automatic HWID cleanup; destructive cleanup starts last.
  - **AC-R018-5:** compatibility remains green for Remnawave 2.7.4 and 2.8.0.
- **Error/boundary:** failed gate keeps corresponding capability disabled; no release action is part of this spec.
- **Dependencies:** all must requirements.
- **Traceability:** D-10, D-11; T-016, T-017, T-018.

## 6. Requirement coverage table

| Requirement | Acceptance criteria | Evidence | Design | Tasks | Primary verification |
|---|---|---|---|---|---|
| R-001 | 1–4 | E-008/009 | D-3/5/8 | T-001/006/013 | catalog DTO/service/admin tests |
| R-002 | 1–5 | E-004/005 | D-4/5/6 | T-002/006/014 | eligibility/unlimited tests |
| R-003 | 1–5 | E-001/002/007 | D-3/4 | T-001/003/004 | ledger/projection DB tests |
| R-004 | 1–4 | E-001/002 | D-3/4/7 | T-003/004/009 | transaction/outbox/concurrency tests |
| R-005 | 1–6 | E-003 | D-4/5/7 | T-005/007/009/015 | crash/replay/recovery tests |
| R-006 | 1–4 | critic | D-4/7/8 | T-003/005/011/013 | state-machine/property tests |
| R-007 | 1–5 | E-005/010/011 | D-4/6/11 | T-002/008/016 | reset epoch fixtures/races |
| R-008 | 1–6 | E-002/009 | D-4/5 | T-007/008/015 | renewal/upgrade integration/E2E |
| R-009 | 1–5 | sync evidence | D-6/7 | T-009/010/016 | stale/retry/read-back tests |
| R-010 | 1–6 | E-005/006 | D-3/6/7 | T-010/011/016 | destructive saga failure injection |
| R-011 | 1–5 | UX evidence | D-5/9 | T-014/015/017 | React contract/a11y/E2E |
| R-012 | 1–4 | ops evidence | D-8/9 | T-013/017 | RBAC/audit/redaction tests |
| R-013 | 1–4 | E-003 | D-8 | T-012/017 | metrics/alert/log tests |
| R-014 | 1–4 | E-005/006 | D-5/6 | T-006/010/014/016 | producer-consumer/vendor contracts |
| R-015 | 1–5 | E-007 | D-3/10 | T-001/004/018 | migration/shadow/rollback tests |
| R-016 | 1–5 | quality gates | D-5/8 | T-005/013/014/017 | authz/rate/payment security tests |
| R-017 | 1–3 | stats evidence | D-8 | T-012 | analytics fixture tests |
| R-018 | 1–5 | critic | D-10/11 | T-016/017/018 | all staged quality gates |

## 7. Review status

- **Gate:** passed after analysis in `analysis.md`.
- **Unresolved blockers/majors:** none.
- **Bounded unknown:** vendor calendar parity; capability remains disabled per strategy until fixture verification.
- **Questions for user:** none required to review this version.
- **Approval:** `ready-for-review` is not approval to implement.
