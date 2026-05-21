# Referral & Partner Settings Matrix

## Purpose

This file captures the settings, invariants, and integration rules that should be
designed before implementing the Referral and Partner verticals in Rezeis.

It is intentionally detailed because Rezeis is split into:

- `rezeis-admin` — authoritative business logic and operator control plane
- `ruid` — user-facing web / Telegram Mini App edge

The settings below are written to keep that split clean.

---

## Referral Program Settings

### Global switches

- `Settings.referrals.enabled`
  - turns the referral program on/off globally
- `Settings.referrals.userDashboardEnabled`
  - controls whether `ruid` exposes referral dashboard reads
- `Settings.referrals.exchangeEnabled`
  - gates all exchange flows independently from invite issuance

### Invite issuance

- `Settings.referrals.invites.maxActiveInvitesPerUser`
- `Settings.referrals.invites.ttlHours`
- `Settings.referrals.invites.allowBotSource`
- `Settings.referrals.invites.allowWebSource`
- `Settings.referrals.invites.allowUnknownSource`

Rules:

- invite creation is admin-owned
- invite revocation is admin-owned
- `ruid` only mirrors user-facing reads / link rendering

### Qualification

- `Settings.referrals.qualification.enabled`
- `Settings.referrals.qualification.purchaseTypes`
- `Settings.referrals.qualification.channels`
- `Settings.referrals.qualification.requireCompletedPayment`
- `Settings.referrals.qualification.oncePerReferredUser`

Rules:

- qualification happens after successful commercial completion
- payment draft creation is never enough
- repeated successful completions must not double-qualify the same referred user unless the product explicitly wants recurring rewards

### Reward issuance

- `Settings.referrals.rewards.level1.enabled`
- `Settings.referrals.rewards.level1.type` (`POINTS`, `EXTRA_DAYS`)
- `Settings.referrals.rewards.level1.amount`
- `Settings.referrals.rewards.level2.enabled`
- `Settings.referrals.rewards.level2.type`
- `Settings.referrals.rewards.level2.amount`

Rules:

- reward issuance is idempotent
- reward issuance is admin-owned
- `ReferralReward.isIssued` remains authoritative admin-side truth

### Exchange balance

- `Settings.referrals.exchange.pointsSource`
  - recommendation: explicit referral-earned balance, not generic money-like wallet
- `Settings.referrals.exchange.allowNegativeBalance` = false
- `Settings.referrals.exchange.auditRequired` = true

Rules:

- referral points are not partner balance
- exchange debit + reward creation must be atomic

### Exchange types

- `Settings.referrals.exchange.subscriptionDays.enabled`
- `Settings.referrals.exchange.subscriptionDays.costPerDay`
- `Settings.referrals.exchange.giftPromocode.enabled`
- `Settings.referrals.exchange.personalDiscount.enabled`
- `Settings.referrals.exchange.purchaseDiscount.enabled`
- `Settings.referrals.exchange.traffic.enabled`

### Gift-promocode exchange specifics

- `Settings.referrals.exchange.giftPromocode.allowedPlanIds`
- `Settings.referrals.exchange.giftPromocode.allowedDurationDays`
- `Settings.referrals.exchange.giftPromocode.codePrefix` (default recommendation: `GIFT_`)
- `Settings.referrals.exchange.giftPromocode.maxGenerateAttempts`

Rules:

- created promo code uses the existing promo bounded context
- one-time use → `maxActivations = 1`
- reward type → `SUBSCRIPTION`
- `planSnapshot` + `durationDays` must be embedded in the resulting promo artifact

---

## Partner Program Settings

### Global switches

- `Settings.partners.enabled`
- `Settings.partners.userDashboardEnabled`
- `Settings.partners.withdrawals.enabled`

### Accrual

- `Settings.partners.accrual.strategy` (`FIRST_PAYMENT`, `EACH_PAYMENT`)
- `Settings.partners.accrual.level1.mode` (`PERCENT`, `FIXED`)
- `Settings.partners.accrual.level1.value`
- `Settings.partners.accrual.level2.mode`
- `Settings.partners.accrual.level2.value`
- `Settings.partners.accrual.level3.mode`
- `Settings.partners.accrual.level3.value`

Rules:

- partner balance is a separate money-like ledger
- partner accrual must never consume referral points storage or exchange balance logic

### Withdrawals

- `Settings.partners.withdrawals.minimumAmount`
- `Settings.partners.withdrawals.supportedMethods`
- `Settings.partners.withdrawals.manualReviewRequired`
- `Settings.partners.withdrawals.autoPauseOnSuspicion`

Rules:

- withdrawal lifecycle is admin-owned
- user edge only submits requests and shows status

---

## API / Boundary Rules

### Admin-owned internal contracts first

Referral first slice:

- `GET /api/internal/referrals/summary`
- `POST /api/internal/referrals/invites`
- `POST /api/internal/referrals/invites/:id/revoke`
- later: `POST /api/internal/referrals/exchange/gift-promocode`

Partner first slice:

- `GET /api/internal/partners/summary`
- `GET /api/internal/partners/earnings`
- later: `POST /api/internal/partners/withdrawals`

### RUID responsibilities

`ruid` may own only:

- auth/session-aware orchestration
- user-safe response shaping
- Telegram/Mini App/browser UX
- invite links / QR presentation
- earnings / points history presentation

`ruid` must not own:

- qualification truth
- reward issuance truth
- exchange debit truth
- partner ledger truth

---

## Audit / Metrics / Permissions Expectations

### Referral audit

- invite created / revoked
- referral qualified
- reward issued
- exchange executed

### Partner audit

- accrual created
- withdrawal requested
- withdrawal approved / rejected / completed

### Permissions

Recommended admin-side write permissions:

- referral settings / invite management → `ADMIN` / `DEV`
- partner settings / withdrawal processing → `ADMIN` / `DEV`
- user-facing reads remain through `ruid`

---

## Recommended Implementation Order

1. Referral core settings + summary
2. Invite issuance / revoke
3. Qualification + reward issuance
4. Gift-promocode exchange
5. Partner ledger core
6. Partner withdrawals
7. Thin `ruid` dashboards and request flows

---

## Non-Negotiable Guardrails

- Referral points ≠ partner balance
- Promo activation flow stays separate from quote/payment unless product explicitly changes it
- `rezeis-admin` owns truth; `ruid` mirrors and presents
