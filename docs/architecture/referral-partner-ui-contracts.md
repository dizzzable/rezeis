# Referral & Partner UI / Contract Plan

## Purpose

This document maps the admin UI, user UI, and internal API contracts that should
exist once the Referral and Partner bounded contexts are implemented in Rezeis.

It complements:

- `referral-bounded-context-minimum.md`
- `referral-bounded-context-first-slice.md`
- `referral-partner-transfer-plan.md`
- `referral-partner-settings-matrix.md`

---

## Admin UI — Referral Program

Suggested `rezeis-admin/web` routes:

- `/growth/referrals`
  - referral summary dashboard
  - invite volume / qualification / reward issuance stats
- `/growth/referrals/invites`
  - active invites list
  - revoke invite action
  - invite source visibility
- `/growth/referrals/rewards`
  - reward issuance history
  - reward status / idempotency audit view
- `/growth/referrals/exchange`
  - manual/operator exchange execution visibility
  - future gift-promocode exchange trace view

Admin screen requirements:

- safe read-first layout before destructive actions
- explicit audit visibility for revoke / exchange actions
- filter by user, inviter, referred user, reward state, qualification state

---

## User UI — Referral Program (`ruid/web`)

Suggested routes:

- `/referrals`
  - referral summary
  - invite link / QR block
  - referral points balance
- `/referrals/exchange`
  - exchange options list
  - selected exchange confirmation flow
- `/referrals/history`
  - reward issuance history
  - exchange history

User UX rules:

- `ruid` renders admin-owned state only
- no balance math in browser
- no exchange settlement in browser
- all writes go through narrow internal admin-backed contracts

---

## Admin UI — Partner Program

Suggested `rezeis-admin/web` routes:

- `/growth/partners`
  - partner summary dashboard
  - active / blocked partner states
- `/growth/partners/earnings`
  - partner accrual history
  - source transaction visibility
- `/growth/partners/withdrawals`
  - withdrawal queue
  - approve / reject / complete actions
- `/growth/partners/settings`
  - accrual levels and withdrawal settings

Admin screen requirements:

- strict operator visibility for ledger mutations
- withdrawal actions must be auditable
- partner balance never edited through user edge

---

## User UI — Partner Program (`ruid/web`)

Suggested routes:

- `/partners`
  - partner summary / current balance
- `/partners/earnings`
  - accrual history
- `/partners/withdrawals`
  - request withdrawal
  - withdrawal status list

User UX rules:

- request creation only
- no direct ledger mutation
- no accrual recalculation in edge

---

## Internal Contract Plan — Referral

### First referral read/write contracts

- `GET /api/internal/referrals/summary?userId=...`
- `GET /api/internal/referrals/invites?userId=...`
- `POST /api/internal/referrals/invites`
- `POST /api/internal/referrals/invites/:id/revoke`

### Future exchange contracts

- `GET /api/internal/referrals/exchange/options?userId=...`
- `POST /api/internal/referrals/exchange/subscription-days`
- `POST /api/internal/referrals/exchange/gift-promocode`
- `POST /api/internal/referrals/exchange/personal-discount`
- `POST /api/internal/referrals/exchange/purchase-discount`
- `POST /api/internal/referrals/exchange/traffic`

Contract rule:

- all exchange responses must return authoritative remaining balance after debit

---

## Internal Contract Plan — Partner

### First partner read/write contracts

- `GET /api/internal/partners/summary?userId=...`
- `GET /api/internal/partners/earnings?userId=...`
- `GET /api/internal/partners/withdrawals?userId=...`
- `POST /api/internal/partners/withdrawals`

### Operator-only admin actions

- `POST /api/admin/partners/withdrawals/:id/approve`
- `POST /api/admin/partners/withdrawals/:id/reject`
- `POST /api/admin/partners/withdrawals/:id/complete`

---

## Acceptance Criteria For Transfer

### Referral Core Acceptance

- users can have active invite tokens
- referred users can be attached and qualified exactly once per configured rule
- rewards are issued idempotently
- referral summary is visible in `ruid`

### Referral Exchange Acceptance

- exchange options come from admin-owned state
- points debit and resulting reward creation are atomic
- gift-promocode exchange returns created promo code + plan snapshot + duration
- exchange history is auditable

### Partner Core Acceptance

- partner balance is visible but remains admin-owned truth
- accrual history can be explained per source transaction
- withdrawal requests and statuses are distinct from accrual history

---

## Testing Expectations

### `rezeis-admin`

- controller contract tests
- service unit tests
- integration-style tests for qualification / exchange / withdrawals
- permission gate coverage on admin write actions

### `ruid`

- API contract tests for referral / partner mirrors
- stale-session invalidation behavior where applicable

### Web

- admin smoke tests for referral / partner operator pages
- user flow tests for invite rendering / exchange / withdrawals
- regression tests for ledger separation semantics in copy and UI states
