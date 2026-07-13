# Codebase Research

```yaml
created_at: 2026-07-11T20:18:53+03:00
workflow: requirements-first
status: complete
spec_version: 1
```

## Current flow

```text
Reiwa Add-ons page
  → Reiwa BFF/admin client
  → Rezeis AddOnPurchaseService
  → Transaction(PENDING, ADDITIONAL, JSON marker)
  → provider/free completion
  → PaymentSubscriptionMutationService.applyAddOnTopUp
  → increment Subscription limit + ProfileSyncJob
  → Remnawave absolute PATCH
```

There is no durable entitlement lifecycle. `Subscription.trafficLimit/deviceLimit` are simultaneously local effective state and projection source, while renewal/upgrade/admin assignment overwrite them from plan values.

## Load-bearing defects

1. Add-on checkout lacks request/provider idempotency.
2. Payment can be completed while entitlement/projection remains unapplied.
3. Unlimited devices can be converted to finite by arithmetic on `-1`.
4. Renewal/upgrade can erase current top-ups.
5. Concurrent absolute sync jobs can apply out of order.
6. Failed UPDATE convergence is incomplete.
7. Remnawave webhook write-back can corrupt future baseline ownership.
8. Historical snapshots cannot prove current entitlement status.

## Existing useful seams

- Add-on catalog CRUD and RBAC already exist.
- Payment snapshots already preserve ID/type/value/name/price target data.
- Webhook inbox and transaction fulfillment claims provide partial deduplication.
- ProfileSyncJob provides a durable DB queue record.
- Exact HWID list/delete adapter methods already exist.
- Renewal has combined checkout and pending-draft reuse to extend with complete fingerprints.

## Test baseline

A child ran five focused current Rezeis suites: 36 passed, 0 failed. Dedicated lifecycle, stacking, reset-boundary, unlimited-device, stale-sync and HWID-saga tests are absent.

## Evidence

See `_runs/20260711-200606-9e4bf3/research-handoff.md` and source report lane 1 for line-level paths.
