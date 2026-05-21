# Subscription Execution Foundation Plan

Scope: `rezeis-admin` backend and `rezeis-admin/web` only. `ruid` is explicitly out of scope.

## Why This Block Is Next

The donor `altshop` treats subscriptions as the central business object: purchases, renewals, extensions, traffic limits, provider synchronization, and payment side effects all converge there. `rezeis-admin` already has a strong subscription read workbench and several safe supporting flows, but subscription execution remains partial.

The next highest-impact business gap is therefore not dashboard/settings polish. It is provider-backed subscription mutation execution.

## Current Rezeis State

Shipped/usable:

- selected subscription workbench;
- selected subscription details;
- selected subscription devices list/revoke through opaque `deviceRef`;
- admin-issued device provisioning challenge;
- internal redeem endpoint;
- backend-only HWID create adapter;
- selected subscription limit mutation scaffolding;
- subscription mutation request/readiness/preflight UI.

Shipped after this foundation slice:

- provider-side subscription/user update adapter through Remnawave `UpdateUserCommand`;
- provider-side traffic reset adapter through Remnawave reset-traffic action;
- provider-side Remnawave profile create adapter for payment-created subscriptions;
- profile sync job executor for `CREATE`, `UPDATE`, and `DELETE` jobs;
- manual single and bounded-batch profile sync job execution from payments reconciliation UI;
- selected subscription `LIMIT_CHANGE` execution with provider-first Remnawave sync and local DB update;
- planned subscription mutation request execution for `LIMIT_CHANGE`;
- planned subscription mutation request execution for `RENEW` / `EXTEND` through provider `expireAt` sync and local `expiresAt` update;
- planned subscription mutation request execution for `TRAFFIC_RESET` through provider reset only;
- selected subscription plan assignment / swap execution with provider-first Remnawave sync and local plan snapshot update;
- selected subscription `ACTIVE` / `DISABLED` status toggle with provider-first Remnawave sync and local status update;
- users cockpit execution UI for planned mutation requests;
- backend tests for Remnawave update/reset adapters and planned mutation execution.

Remaining partial / blocked:

- donor-style upgrade traffic reset is implemented as an explicit admin-controlled `resetTraffic` flag on plan assignment; remaining work is operator policy/defaulting, not provider mechanics;
- current subscription fallback/reassignment is computed in the workbench and status-change execution now returns `nextCurrentSubscriptionId`; remaining work is only deeper lifecycle coverage for delete/expire jobs;
- payment-coupled subscription purchase/renewal orchestration is now wired through `ProfileSyncJob` create/update/delete execution, bounded batch processing, retry scheduling, failed-job visibility, manual retry reset, manual compensation notes, force-provider-link compensation, and automatic bounded profile-sync batch after successful payment reconciliation; remaining work is rollback/cancel-local-mutation semantics for permanently failed provider sync jobs;
- broader subscription lifecycle state machine and compensation semantics.

## Donor Parity Notes From Deep Audit

`altshop-1.5.0/src/services/remnawave_sync_crud.py` updates Remnawave users via `update_user(...)` with provider fields that are not all represented in the current Rezeis adapter:

- `active_internal_squads`
- `external_squad_uuid`
- `description`
- `tag`
- `expire_at`
- `hwid_device_limit`
- `status`
- `telegram_id`
- `traffic_limit_bytes`
- `traffic_limit_strategy`

It then optionally calls `reset_user_traffic(...)` and returns the Remnawave `UserResponseDto`. Donor purchase/renewal code persists local state from that returned provider object. Rezeis now maps bounded provider response fields from `UpdateUserCommand` and uses them in expiration/status/plan assignment paths.

Completed donor-parity steps:

1. `RemnawaveApiService.updateSubscriptionUser(...)` returns a bounded provider result.
2. `RENEW`/`EXTEND` persist provider-final `expireAt` where returned.
3. Plan assignment persists provider-final limits/squads where returned.
4. Payment-created subscriptions can create/update/delete Remnawave profiles through `ProfileSyncJobExecutorService`.
5. Plan assignment can optionally reset provider traffic in the same execution path.
6. Terminal failed profile sync jobs can receive bounded manual compensation notes; non-failed jobs are blocked.
7. Status-change execution returns `nextCurrentSubscriptionId`, preserving donor-style fallback visibility without storing a fragile current-subscription pointer.

Practical next implementation order:

1. Decide operator policy/default for donor-style traffic reset during upgrade/plan assignment.
2. Define rollback/force-link compensation semantics for permanently failed profile sync jobs.
3. Extend fallback visibility to future hard-delete/expire lifecycle executors if those are added.

## Donor-Informed Target Capabilities

From `altshop-1.5.0`, subscription execution includes:

- subscription purchase execution;
- subscription core update logic;
- plan sync;
- provider synchronization;
- renewal/extension logic;
- traffic/device/limit business rules;
- payment-related side effects;
- audit/reconciliation style operational behavior.

## Implementation Boundary

Do not add a UI button that only mutates local database state while Remnawave remains stale.

Before real renew/extend/reset execution, `rezeis-admin` needs a backend-owned provider mutation adapter. The first implementation slice must identify or implement Remnawave mutation contracts for subscription/user update operations.

## Phase Plan

### Phase S1 — Remnawave Subscription Mutation Contract Audit

Goal: find exact provider contracts for:

- user/subscription update;
- expiration update;
- traffic/device limit update;
- enable/disable;
- traffic reset.

Inputs:

- local `@remnawave/backend-contract` package;
- current `RemnawaveApiService` implementation;
- Remnawave public docs / API docs;
- `backend-main` patterns if available in workspace;
- existing local OpenAPI artifacts if present.

Output:

- exact endpoint/method/request/response contracts, or explicit blockers.

### Phase S2 — Backend-Only Remnawave Adapter

If a contract is found, add backend-only adapter methods in `RemnawaveApiService`, with tests proving:

- endpoint and method;
- request shape;
- auth/header behavior;
- response mapping;
- provider failure behavior;
- no raw provider payload returned to admin UI.

Status: shipped.

- `updateSubscriptionUser(...)` uses official `UpdateUserCommand` / `PATCH /api/users`.
- `resetSubscriptionTraffic(...)` uses OpenAPI-confirmed `POST /api/users/{uuid}/actions/reset-traffic`.
- Both are covered by backend adapter tests.

### Phase S3 — First Safe Subscription Executor

Preferred first executor: selected subscription limit sync, because local limit mutation already exists.

Execution must:

- validate selected subscription belongs to user;
- validate mutation request/readiness;
- update provider first or use clearly documented transaction/compensation ordering;
- update local DB;
- write audit;
- preserve idempotency;
- expose bounded success/failure only.

Status: shipped for `LIMIT_CHANGE`.

- Planned mutation requests can carry `trafficLimit` / `deviceLimit`.
- Executor validates the selected subscription request and calls the selected-subscription limits executor.
- Provider sync happens before local DB update when `remnawaveId` and provider service are available.
- Result exposes `providerMutation` and `databaseMutation` only.

### Phase S4 — Renew/Extend Executor

Only after provider update adapter is proven.

Must explicitly decide:

- whether local expiry or provider expiry is source of truth;
- timezone/date behavior;
- expired vs active extension behavior;
- payment/reconciliation relation;
- rollback/compensation semantics.

Status: shipped for planned `RENEW` and `EXTEND` requests.

- Planned requests carry `durationDays`.
- Expiration base is `max(now, current expiresAt)`.
- Provider `expireAt` sync happens through Remnawave `UpdateUserCommand`.
- Local `Subscription.expiresAt` is updated after provider sync.
- Audit records previous/current expiry, duration, request id, and provider mutation state.

### Phase S5 — Traffic Reset Executor

Only after exact Remnawave traffic reset contract is known.

Status: shipped for planned `TRAFFIC_RESET` requests.

- Contract source: local OpenAPI `POST /api/users/{uuid}/actions/reset-traffic`.
- Executor validates selected subscription and invokes provider reset.
- Local DB is intentionally not changed; result returns `databaseMutation=false`.
- Audit records request id, user/subscription ids, and provider mutation state.

### Phase S6 — Plan Assignment / Swap Executor

Status: shipped for selected subscription plan assignment.

- Readiness validates selected subscription, target plan existence, target plan active/not archived, current plan snapshot detection, and upgrade/replacement rule compatibility when available.
- Executor syncs Remnawave first through `UpdateUserCommand` with `trafficLimitBytes`, `hwidDeviceLimit`, `activeInternalSquads`, and `externalSquadUuid`.
- Local `Subscription` update stores the new `planSnapshot`, `trafficLimit`, `deviceLimit`, `internalSquads`, and `externalSquad` only after provider sync.
- Users cockpit exposes target-plan readiness and an execute button with bounded provider/database mutation result.
- Backend and web smoke coverage prove the provider payload and UI flow.

## Current Acceptance State

- Phase S1: complete.
- Phase S2: complete.
- Phase S3: complete for `LIMIT_CHANGE`.
- Phase S4: complete for `RENEW` and `EXTEND`.
- Phase S5: complete for `TRAFFIC_RESET`.
- Phase S6: complete for selected plan assignment / swap.

Remaining subscription business work should now move to a new plan covering subscription grant/toggle and payment-coupled subscription orchestration.

## Acceptance Criteria For Phase S1

- A concrete Remnawave contract matrix exists in code/docs.
- No fake provider adapter is implemented.
- If exact contracts are missing, execution remains blocked with evidence.
- If exact contracts are found, Phase S2 starts with backend-only adapter tests.
