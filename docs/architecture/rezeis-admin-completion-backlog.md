# Rezeis Admin Completion Backlog

This document is the master backlog for bringing `rezeis-admin` closer to donor-level admin-panel completeness.

Primary implementation target: `rezeis-admin` and `rezeis-admin/web`.

Donor source: `altshop-1.5.0`.

Architecture quality reference: `backend-main` / Remnawave patterns.

`ruid` remains out of implementation scope unless a future task explicitly reopens the user-facing/BFF rebuild.

## Status Legend

- `SHIPPED` — implemented and verified in `rezeis-admin`.
- `PARTIAL` — implemented enough to operate, but missing donor depth or hardening.
- `MISSING` — no real backend/web implementation yet.
- `BLOCKED` — intentionally not implementable yet because a safe seam, source of truth, or product decision is missing.

## Decision Rules

1. Prefer backend-first contracts for new capabilities.
2. Do not add UI controls that do not have a real backend source of truth.
3. Do not expose raw identifiers or secrets in admin UI/API: HWID, config URLs, tokens, recovery codes, provider payloads, Remnawave UUIDs.
4. Every mutation needs RBAC, audit, idempotency, rollback/terminal-state behavior, and tests.
5. For high-risk flows, start with draft/preview/dry-run/read-only slices before execution.
6. Keep `ruid` out of implementation scope until the user-facing/BFF rebuild is intentionally started.

## Global Completion Matrix

| Domain | Status | Current evidence | Main remaining gap | Priority |
|---|---|---|---|---|
| Users/support cockpit | SHIPPED/PARTIAL | Deep `/users/search`, queues, access diagnostics, subscription/device/provisioning workbench | Remaining high-risk user mutations and donor web-bind/panel-sync depth | High |
| Subscription execution workbench | SHIPPED/PARTIAL | multi-subscription reads, selected subscription/devices, Remnawave update/reset/create adapters, planned mutation execution for LIMIT_CHANGE/RENEW/EXTEND/TRAFFIC_RESET, renew-with-replacement, selected plan assignment/swap with provider sync, selected ACTIVE/DISABLED status toggle, profile sync job create/update execution | upgrade traffic-reset semantics, current-subscription fallback, profile-sync automation/compensation, and deeper payment-coupled lifecycle orchestration | High |
| Device provisioning | PARTIAL | challenge issue/revoke, backend adapter, internal redeem | User-facing/BFF handoff outside admin scope | High / blocked by `ruid` rebuild |
| Payments ops | SHIPPED/PARTIAL | transactions, checkout, gateways, webhooks, replay, reconciliation, YooKassa + Heleket refund readiness/request/preflight/execution/history, finance correction notes, manual dispute records, manual reconciliation exception records, amount-adjustment correction executor | MARK_COMPLETED correction execution, deeper reconciliation automation, Platega/MulenPay refund contract verification, provider-native dispute webhooks | High |
| Promocodes | PARTIAL | CRUD, activation, history | controller-heavy activation and placeholder service seams | Medium |
| Referrals | PARTIAL | admin summary/invites/rewards, invited queue enrichment | admin qualify/exchange and donor invite-source attribution | Medium |
| Partners | PARTIAL | summary, earnings, withdrawals approve/reject/complete | payout provider execution, cancel route, analytics/config depth | Medium |
| Settings/API tokens/access mode | SHIPPED/PARTIAL | platform settings, API tokens, payment ops alerts, admin token usage analytics, token revoke request/readiness/executor | token creation UX polish, broader access-mode analytics | Medium |
| RBAC / Admin Management | SHIPPED/PARTIAL | governance policy matrix, RBAC capability matrix, admin listing/detail, role-change request/readiness/executor, active-state request/readiness/executor, token usage/revoke lifecycle | finer permission model | Medium |
| Remnawave diagnostics | PARTIAL | status, API wrapper, devices integration | broader provider diagnostics/sync repair | Medium |
| Dashboard analytics | PARTIAL | backend summary KPIs and operations timeline | deeper charts, retention cohorts, provider health analytics | High |
| Broadcast | SHIPPED/PARTIAL | draft/audience/preview/readiness, delivery runs, recipient staging, manual send/delete/retry/cancel lifecycle | background worker, scheduler, rich media/buttons, deep delivery analytics | Critical |
| Imports | SHIPPED/PARTIAL | dry-run, sanitized history/detail, staging rows, email-user commit, rollback trail/execution/readiness | broader source formats, plan assignment, update existing users, rollback UI depth | Critical |
| Backup/restore | SHIPPED/PARTIAL | manifest, export policy, imports export/download/audit, restore policy/dry-run/history/detail/readiness/gate | restore commit, broader domains beyond imports | Medium/High |
| Support/tickets | MISSING | no module | ticket/escalation workflow if desired | Medium |

## Multi-Agent Audit Synthesis

The full-panel audit confirmed that the next completion work should move away from adding more users-cockpit cards and toward missing admin modules and backend-first mutation foundations.

### Broadcast audit result

Donor `altshop` has a real bot-oriented broadcast workflow: audience selection, plan targeting, content/media capture, preview, optional promo button, async send task, progress/status, cancel, delete sent messages, and cleanup.

Current `rezeis-admin` now has a real broadcast module and `/broadcast` page. Shipped capabilities include draft persistence, list/detail/update, audience preview, backend-owned message preview/validation, send readiness checklist, delivery run persistence, recipient staging, single-recipient send, manual batch send, terminal safety, cancel, single and bulk delete of delivered messages, and retry of failed recipients.

Still remaining for donor-level depth:

- background worker delivery;
- scheduling;
- rich media/button payloads;
- delivery analytics and cleanup retention;
- deeper RBAC/rate-limit policy.

### Imports audit result

Donor imports are real but narrow: 3X-UI SQLite import, Remnawave panel sync, and optional plan assignment. `rezeis-admin` has only `/imports` placeholder and no backend importer module.

First safe implementation slice should be dry-run only: upload metadata, parser/detector, validation report, staging preview, and no commit.

### Dashboard analytics audit result

`rezeis-admin` dashboard was visually scaffolded but analytically incomplete. Phase 1 now ships a backend KPI summary contract and wires the dashboard stat cards to backend-owned values.

Shipped Phase 1 boundary:

- backend `GET /admin/dashboard/summary`;
- bounded KPI summary for users, subscriptions, transactions, and operations;
- web dashboard stat cards use backend-owned values instead of static copy;
- no raw payment gateway payloads, user rows, provider payloads, or private identifiers are exposed.

### Finance/payment audit result

Payments operations are strong. YooKassa and Heleket refunds now have finance-safe readiness, planned requests, audit trail, preflight, provider adapters, execution, execution history, and web flow coverage. Finance correction notes, manual dispute records, manual reconciliation exception records, amount/status correction request ledger/readiness, and real `ADJUST_AMOUNT` correction execution are shipped with audit/test coverage. Remaining gaps are `MARK_COMPLETED` correction execution, provider-native dispute webhook integration, Platega/MulenPay refund contract verification, and deeper reconciliation automation. `MARK_COMPLETED` is explicitly blocked by subscription side-effect idempotency, provider reconciliation evidence, and webhook replay policy requirements.

### Subscription/user mutation audit result

Subscription mutation execution is now materially shipped for the first provider-backed set: planned requests support `LIMIT_CHANGE`, `RENEW`, `EXTEND`, and `TRAFFIC_RESET`, renew-with-replacement, selected plan assignment/swap, selected ACTIVE/DISABLED status toggle, and profile sync job CREATE/UPDATE execution, with Remnawave sync, audit, bounded execution results, backend tests, users cockpit coverage, and reconciliation UI triggers. A deeper `altshop` audit identified remaining donor-parity gaps: upgrade-time traffic reset, current-subscription fallback after lifecycle changes, automatic profile-sync retry/compensation, and deeper payment-coupled lifecycle orchestration. User cockpit mutations such as role/commercial/support/web-account are also implemented in the admin panel, while deeper donor web-bind/panel-sync parity remains separate.

## Priority Program

### P0 — Build missing admin modules safely

1. Broadcast Phase 1 — drafts and audience preview, no sending.
2. Imports Phase 1 — dry-run parser/staging, no commit.
3. Dashboard Analytics Phase 1 — real backend KPI overview. **Shipped.**

### P1 — Complete high-value existing modules

4. Subscription Admin Mutations Phase 1 — provider-backed LIMIT_CHANGE/RENEW/EXTEND/TRAFFIC_RESET with audit/idempotency. **Shipped.**
5. User Moderation Phase 1 — block/unblock or status mutation with audit and explicit constraints.
6. Payment Finance Ops Phase 1 — refunds/manual correction design and preview.

### P2 — Harden and deepen existing business areas

7. Promocode activation service refactor to remove placeholder production seams.
8. Referral admin qualify/exchange surface.
9. Partner payout/provider integration or cancel route.
10. RBAC/admin user management.
11. Backup/export design.

## Module Backlogs

### Broadcast

Status: `MISSING`.

Known current state:

- Frontend route exists but behaves as placeholder or weak shell.
- Backend audit found no dedicated broadcast module/controller/service.

Target donor-level capabilities:

- Draft campaign.
- Audience targeting and count preview.
- Message preview.
- Schedule/send/cancel.
- Delivery status and failure report.

Safe phase plan:

1. Phase 1: backend draft + audience preview only.
2. Phase 2: draft edit/update and selected draft metadata polish. Shipped in web after Phase 1 without adding send controls.
3. Phase 3: message preview and validation.
4. Phase 4: send execution behind RBAC/rate limits.
5. Phase 5: delivery analytics.

Phase 1 acceptance boundary:

- No messages are sent.
- Drafts are persisted.
- Audience preview returns counts and samples without leaking sensitive user fields.
- Every preview is based on explicit filters.
- Tests cover draft create/list/detail/update and audience preview.

Phase 2 acceptance boundary:

- Existing drafts can be selected for editing.
- Update calls reuse the backend draft update route.
- Selected draft detail shows metadata/counts only.
- No send, schedule, cancel, or delivery-worker controls are introduced.
- Web smoke covers create + edit/update + no-send-control behavior.

### Imports

Status: `MISSING`.

Known current state:

- Frontend route exists as placeholder or weak shell.
- Backend audit found no imports module.

Safe phase plan:

1. Phase 1: upload metadata + dry-run parser, no database writes.
2. Phase 2: staging rows and validation report.
3. Phase 3: commit with idempotency and rollback plan.
4. Phase 4: historical import reports.

Phase 1 acceptance boundary:

- No persistent business writes are made.
- Parser returns row counts, accepted/rejected counts, and validation errors.
- Uploaded file contents are not exposed raw in admin responses.
- Tests cover supported file formats and invalid inputs.

### Dashboard Analytics

Status: `MISSING/PARTIAL`.

Known current state:

- Dashboard UI exists but is not backed by a mature analytics backend contract.

Safe phase plan:

1. Phase 1: read-only KPI overview.
2. Phase 2: time-series and drilldowns.
3. Phase 3: operational alerts and anomaly widgets.

Phase 1 acceptance boundary:

- Backend returns a bounded analytics snapshot.
- Metrics are explicitly defined: users, subscriptions, payments, failed webhooks, pending partner withdrawals, active payment alerts.
- No expensive unbounded queries.
- Tests cover query shape and date-window handling.

### Subscription Admin Mutations

Status: `PARTIAL/BLOCKED`.

Already shipped:

- Quote/action-policy.
- Multi-subscription workbench.
- Selected subscription detail.
- Selected devices list/revoke.
- Access diagnostics.
- Mutation governance catalog.
- Selected-subscription renewal/extension readiness.
- Planned mutation request draft/history/detail/preflight scaffolding.

Remaining donor-level mutations:

- Grant subscription.
- Renew/upgrade/downgrade execution.
- Toggle active/disabled.
- Reset traffic.
- Device limit changes.

Safe phase plan:

1. Choose one lowest-risk mutation.
2. Define RBAC and audit semantics.
3. Add dry-run/preview endpoint before mutation.
4. Add idempotent execution endpoint.

Traffic reset execution gate:

- `TRAFFIC_RESET` preflight is action-aware and explicitly blocked by `TRAFFIC_RESET_PROVIDER_ADAPTER_MISSING`.
- Current repo search and official Remnawave docs confirm traffic reset as a panel/business feature, but no exact version-pinned API endpoint contract is present in the local workspace.
- Do not implement traffic reset execution until the exact Remnawave endpoint, method, request shape, response shape, idempotency behavior, and failure semantics are verified.
- Once verified, the next safe slice is backend-only `RemnawaveApiService.resetUserTraffic(...)` with tests; only after that can the audited executor run a real mutation.

### User Moderation and Support Mutations

Status: `PARTIAL`.

Already shipped:

- Bounded linked web-account actions.
- Device revoke.
- Device provisioning challenge lifecycle.
- Access diagnostics.
- User block/unblock moderation with idempotent state changes and bounded `AdminAuditLog` metadata.

Remaining donor-level actions:

- Points/discount edit.
- Max subscriptions override.
- Direct message user.
- Role change.

Safe phase plan:

1. Block/unblock is shipped as Phase 1.
2. Keep future points/discount/max-subscription/role/direct-message actions behind explicit per-action design.
3. Require reason, audit metadata, idempotency, status-gated UI, and reversal behavior for every future mutation.
4. Do not batch unrelated user mutations into one generic endpoint.

### Payments Finance Ops

Status: `PARTIAL`.

Already shipped:

- Transactions.
- Checkout.
- Gateways.
- Webhooks/replay.
- Reconciliation.
- YooKassa and Heleket refund readiness/request/history/detail/preflight/execution/execution history.

Remaining donor/operator gaps:

- Refunds for Platega/MulenPay remain blocked until exact refund endpoint/request/signature contracts are verified.
- Manual finance corrections.
- Chargeback/dispute views.
- Stronger reconciliation exception workflow.

Safe phase plan:

1. Refund readiness/request/preflight/history is shipped.
2. YooKassa and Heleket refund provider adapters and execution are shipped.
3. Next safe phases: Platega/MulenPay refund adapters only with exact provider contracts; manual corrections as separate audited ledger mutations; chargeback/dispute read-side before mutation.
4. Reconciliation integration should consume refund execution audit/history rather than inferring provider state from raw payloads.

### Promocodes

Status: `PARTIAL`.

Known issue:

- Controller path carries real activation logic while `PromocodeActivationService` still has placeholder seams.

Needed cleanup:

- Move activation persistence/orchestration into service.
- Keep controller thin.
- Preserve existing behavior with tests.

### Referrals

Status: `PARTIAL`.

Remaining gaps:

- Admin qualify/exchange surface.
- Invite source attribution if a real backend field/source is introduced.

### Partners

Status: `PARTIAL`.

Remaining gaps:
- Withdrawal cancel support if product wants it.
- Payout provider execution.
- Partner analytics/config.

### RBAC / Admin Management

Status: `SHIPPED/PARTIAL`.

Shipped:

- Governance mutation policy catalog.
- RBAC capability matrix for real Prisma roles `DEV`, `ADMIN`, `USER`.
- Admin role-change readiness gate.
- Planned admin role-change request ledger.
- Safe-case role-change executor with self-demotion and only-`DEV` lockout guards.
- Admin user listing/detail management with bounded admin metadata and recent audit actions.
- Admin active-state readiness gate.
- Planned admin active-state request ledger.
- Safe-case admin deactivate/reactivate executor with self-disable and only-active-`DEV` lockout guards.
- Governance UI for policy, RBAC matrix, admin list/detail, request creation/history/readiness/execution.
- Service/controller tests for role-change and active-state execution.

Remaining gaps:

- Token usage analytics.
- Fine-grained permission matrix.

## Next Implementation Recommendation

Recommended first implementation slice from this backlog:

**Broadcast Phase 1 — backend draft + audience preview, no sending.**

Reason:

- Entire donor module is missing.
- It is high operator value.
- It can be made safe by starting with drafts/previews only.
- It does not depend on `ruid`.
- It creates a foundation for later send execution.
