# Promocodes Implementation Status

Updated on 2026-04-20 from the current repository state and local verification runs.

## Implemented And Verified

The following promo slices are present in code and were verified locally during the current work session:

- Admin-owned promo contract, schema hardening, CRUD, activation, activation history, and reward branching.
- `ruid` promo public edge (`activate`, `eligible-subscriptions`, `activations`) backed by the internal admin contract.
- Admin UI for promo management and user UI for promo activation/history.
- Audit trail for promo writes and activation.
- Structured promo metrics / correlation logging slice.
- Promo write permission gates on admin controller actions.
- API contract tests in `ruid`.
- Web tests for admin promo page and user promo activation page.
- Regression confidence through full backend, backend-edge, and web test suites.

## Verified Local Quality Signals

- `rezeis-admin` test suite: green
- `ruid` backend pytest suite: green
- `rezeis-admin/web` vitest suite: green
- `ruid/web` vitest suite: green

## Still Blocked Or Not Safe To Claim As Fully Shipped

### G1 — Referral Gift Promocode Flow

Implemented as a first practical slice.

Reason:

- A referral bounded-context first slice now exists in `rezeis-admin`.
- Admin-side qualification / rewards / gift-promocode exchange foundation exists.
- `ruid` now mirrors referral summary / invites / gift-promocode exchange as a thin public edge.
- `ruid/web` now exposes a referral summary / invite / exchange page.

See:

- `docs/architecture/referral-bounded-context-minimum.md`
- `docs/architecture/referral-bounded-context-first-slice.md`

### G2 — Promo In Quote / Payment Path

Deliberately not implemented.

Reason:

- The current shipped promo flow is intentionally separate from the quote/payment flow.
- Merging promo input into quote/payment remains an explicit future business decision.

### I2 — Full Database-Backed Race Harness

Partially advanced, not fully exhaustive.

Current coverage includes integration-style controller/service slices around activation behavior, filtering, metrics, and write gates. A dedicated Prisma-backed concurrency harness would still be required for strict race-proof closure.

## Important Bookkeeping Note

The current work session treated `.sisyphus/plans/*.md` as read-only / sacred, so visible plan checkboxes may not reflect the repository state. This file exists to bridge that gap with a repo-native status artifact.
