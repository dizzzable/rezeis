# Referral & Partner Transfer Plan

Updated on 2026-04-20 after shipping the promo vertical slice.

## Purpose

This document defines the next business-logic transfer milestone for Rezeis after
the promo vertical slice: **Referral Program** first, then **Partner Program**.

It is intentionally shaped for the Rezeis architecture:

- `rezeis-admin` = business truth, control plane, admin APIs, authoritative state
- `ruid` = thin user-facing edge, Telegram/Mini App/browser UX, session-aware BFF

This is a transfer plan, not a claim that these features are already implemented.

---

## Guiding Rule

Referral must be built **before** partner payouts and before any gift-promocode
exchange. Partner accrual may depend on adjacent commercial events, but partner
balance must stay a separate ledger from referral points.

Order of business-logic transfer:

1. Referral identity + invite system
2. Referral qualification + reward issuance
3. Referral exchange flows (including gift-promocode)
4. Partner profile + partner accrual ledger
5. Partner withdrawals / partner portal

---

## Phase 1 — Referral Foundation

### Goal

Make referrals a first-class bounded context in `rezeis-admin`.

### Admin-owned responsibilities

- invite token generation and revocation
- referrer ↔ referred graph truth
- qualification rules after successful purchase completion
- referral reward issuance
- exchangeable referral points balance

### Proposed module shape

`rezeis-admin/src/modules/referrals/`

- `controllers/`
  - `admin-referrals.controller.ts`
  - `internal-referrals.controller.ts`
- `services/`
  - `referral-invites.service.ts`
  - `referral-graph.service.ts`
  - `referral-qualification.service.ts`
  - `referral-rewards.service.ts`
  - `referral-summary.service.ts`
- `dto/`
  - invite create/list/revoke dto
  - summary dto

### First internal contracts

- `GET /api/internal/referrals/summary?userId=...`
- `POST /api/internal/referrals/invites`
- `POST /api/internal/referrals/invites/:id/revoke`

### RUID edge after Phase 1

`ruid` may expose only:

- referral dashboard summary read
- invite link / QR rendering
- referral invite list / revoke UX if product requires it

No exchange yet.

### Required settings

Admin-owned settings should be centralized, likely inside `Settings` JSON or a new
referral config block:

- referral program enabled
- max active invites per user
- invite TTL
- qualification purchase types / channels
- reward levels enabled (L1/L2/etc.)
- reward type per level (`POINTS`, `EXTRA_DAYS`)
- reward amount per level

### Suggested settings matrix

Minimal first-slice admin settings:

- `Settings.referrals.enabled`
- `Settings.referrals.maxActiveInvitesPerUser`
- `Settings.referrals.inviteTtlHours`
- `Settings.referrals.qualification.purchaseTypes`
- `Settings.referrals.qualification.channels`
- `Settings.referrals.levels[1].enabled`
- `Settings.referrals.levels[1].rewardType`
- `Settings.referrals.levels[1].rewardAmount`
- `Settings.referrals.levels[2].enabled` (future-safe, optional)
- `Settings.referrals.levels[2].rewardType`
- `Settings.referrals.levels[2].rewardAmount`

---

## Phase 2 — Referral Qualification & Reward Issuance

### Goal

Tie referral business effects to successful commercial completion, not to payment
draft creation.

### Core rule

Reward issuance happens **after** successful purchase/subscription completion.

### Trigger points

Potential admin-owned trigger sources:

- successful transaction reconciliation
- successful subscription creation/renew/upgrade completion

### Required behaviors

- identify the referred user
- determine qualification event
- create or mark `Referral.qualifiedAt`
- issue referral reward rows (`ReferralReward`)
- mark reward issuance state and audit it

### Tests required

- reward is not issued on pending payment
- reward is issued once on first qualifying completion
- repeat completion does not double-issue reward
- referral reward respects configured level/amount

---

## Phase 3 — Referral Exchange Flows

### Goal

Allow users to spend referral-earned points on admin-owned rewards.

### Exchange types to support (ordered)

1. subscription days
2. gift promocode (`G1`)
3. personal discount
4. purchase discount
5. traffic bonus

### Gift-promocode exchange contract

This is the future completion target for current `G1`.

Admin-owned exchange endpoint:

- `POST /api/internal/referrals/exchange/gift-promocode`

Request:

- `userId`
- `planId`
- `durationDays`

Response:

- `promoCode`
- `planSnapshot`
- `durationDays`
- `pointsSpent`
- `pointsRemaining`

### Exchange implementation rules

- resolve referral exchange balance
- validate plan + duration selection
- debit points atomically
- create resulting reward atomically
- write exchange audit trail
- return user-safe response

### Important separation

Referral points are **not** partner balance.

---

## Phase 4 — Partner Foundation

### Goal

Introduce partner program as a separate money-like ledger domain.

### Admin-owned responsibilities

- partner profile management
- accrual rules and level settings
- balance ledger
- earnings history
- withdrawal requests and processing

### Proposed module shape

`rezeis-admin/src/modules/partners/`

- `controllers/`
  - `admin-partners.controller.ts`
  - `internal-partners.controller.ts`
- `services/`
  - `partner-profile.service.ts`
  - `partner-accrual.service.ts`
  - `partner-ledger.service.ts`
  - `partner-withdrawals.service.ts`
- `dto/`
  - summary / history / withdrawal dto

### First internal contracts

- `GET /api/internal/partners/summary?userId=...`
- `GET /api/internal/partners/earnings?userId=...`
- `POST /api/internal/partners/withdrawals`

### Required settings

- partner program enabled
- accrual strategy (`FIRST_PAYMENT`, `EACH_PAYMENT`)
- reward mode (`PERCENT`, `FIXED`)
- level percentages / amounts
- withdrawal minimums
- supported payout methods

### Suggested settings matrix

Minimal first-slice partner settings:

- `Settings.partners.enabled`
- `Settings.partners.accrualStrategy`
- `Settings.partners.levels[1].rewardMode`
- `Settings.partners.levels[1].rewardValue`
- `Settings.partners.levels[2].rewardMode`
- `Settings.partners.levels[2].rewardValue`
- `Settings.partners.levels[3].rewardMode`
- `Settings.partners.levels[3].rewardValue`
- `Settings.partners.withdrawals.enabled`
- `Settings.partners.withdrawals.minimumAmount`
- `Settings.partners.withdrawals.supportedMethods`

---

## Phase 5 — RUID User Edge

Only after admin-owned truth exists:

### Referral UI

- referral dashboard page
- active invite links / QR
- referral points balance
- exchange flow UI
- activation/result states for exchanged rewards

Suggested routes:

- `/referrals`
- `/referrals/exchange`
- `/referrals/history`

### Partner UI

- partner summary page
- earnings history
- withdrawal request page
- withdrawal status history

Suggested routes:

- `/partners`
- `/partners/earnings`
- `/partners/withdrawals`

`ruid` remains thin: it mirrors admin-owned contracts and renders user-facing flows.

---

## Suggested Milestone Sequence

### Milestone A — Referrals Core

- referral module scaffold
- summary + invites
- qualification + rewards

### Milestone B — Referral Exchange

- points balance resolution
- subscription-days exchange
- gift-promocode exchange

### Milestone C — Partner Core

- partner ledger
- accrual rules
- partner summary reads

### Milestone D — Partner Withdrawals

- withdrawal workflow
- operator review + processing
- user-facing withdrawal status

---

## Definition Of Done Per Slice

### Referral Core Done

- referral internal contracts exist
- invite issuance/revoke works
- qualification is tied to successful purchase completion
- reward issuance is idempotent
- admin and `ruid` test coverage exists

### Referral Exchange Done

- referral points balance is resolved authoritatively
- exchange debit + reward creation is atomic
- gift-promocode exchange returns code + plan snapshot + duration
- audit trail and operator visibility exist

### Partner Core Done

- partner ledger is separate from referral points
- earnings history exists
- accrual rules are configurable
- `ruid` mirrors only user-safe reads

### Partner Withdrawals Done

- request / review / completion states exist
- minimums and payout methods are configurable
- admin-side processing is audited

---

## What Must Not Be Coupled

- referral points ↔ partner balance
- promo activation ↔ quote/payment path (unless product explicitly changes this)
- `ruid` ↔ business truth ownership

---

## Definition Of A Safe Next Step

The next real engineering milestone after promo should be:

> ship `rezeis-admin` referral bounded-context first slice (summary + invites +
qualification + rewards), then mirror that thinly through `ruid`.

Only after that is complete should gift-promocode exchange be considered a normal
follow-on task.
