# Referral Bounded Context Minimum

## Purpose

This note defines the minimum admin-owned referral bounded context that must exist
before Rezeis can safely implement AltShop-style referral exchange flows such as
gift promocode issuance.

It is intentionally architecture-first. It does not claim that the flows below are
already shipped.

## Why This Exists

The current Prisma schema already contains:

- `Referral`
- `ReferralInvite`
- `ReferralReward`
- `User.points`

But the repo still lacks a shipped `rezeis-admin` referral module with controllers,
services, and transactional workflows. Because of that gap, `G1` gift-promocode
exchange cannot be implemented as a thin wiring step.

## Minimum Required Capabilities

### 1. Referral Identity And Invite Ownership

`rezeis-admin` must own:

- referral invite creation
- invite revoke / expiry handling
- referral attach / qualification rules
- referrer ↔ referred graph truth

Without this, there is no authoritative way to decide who is allowed to exchange
referral rewards.

### 2. Referral Reward Ledger

`rezeis-admin` must expose one authoritative reward balance model for referral
exchange.

Minimum behavior:

- accumulate referral-earned points
- distinguish issued vs available rewards
- compute exchangeable balance for a given user
- keep partner-balance semantics separate

At current repo state, `User.points` may be a starting storage location, but the
service boundary must still make it explicit that referral points are not general
cash-like balance.

### 3. Referral Exchange Transaction

`rezeis-admin` must own one transactionally safe exchange workflow that:

1. resolves the caller's exchangeable referral balance
2. validates the selected exchange type and plan target
3. debits referral points atomically
4. creates the resulting reward artifact atomically
5. records an exchange outcome / audit trail

For a gift-promocode exchange, the reward artifact is a new `PromoCode` with:

- generated code (for example `GIFT_XXXXXXXX`)
- `rewardType = SUBSCRIPTION`
- `rewardValue = <durationDays>`
- `planSnapshot = <selected plan snapshot>`
- `maxActivations = 1`
- `availability = ALL` or a stricter explicit rule if product requires it

### 4. Internal Execution Contract

Before `ruid` can expose a public referral exchange entrypoint, `rezeis-admin`
needs a narrow internal contract. A minimal future slice would look like:

- `POST /api/internal/referrals/invites`
- `GET /api/internal/referrals/summary`
- `POST /api/internal/referrals/exchange/gift-promocode`

The gift-promocode exchange contract must accept at least:

- `userId`
- `planId`
- `durationDays`

And return at least:

- `promoCode`
- `planSnapshot`
- `durationDays`
- `pointsSpent`
- `pointsRemaining`

### 5. Public Edge Responsibilities

Once the admin-owned exchange contract exists, `ruid` may remain thin and own only:

- session-aware referral dashboard reads
- invite link / QR presentation
- public user-triggered exchange requests
- response shaping for browser / Mini App clients

`ruid` must not own referral balance truth or exchange settlement.

## Safe Implementation Order

1. ship referral module + service boundary in `rezeis-admin`
2. expose internal referral summary + exchange endpoints
3. add gift-promocode exchange service using existing promo primitives
4. mirror the narrow contract through `ruid`
5. add user-facing referral exchange UI

## Explicit Non-Goals

This minimum does **not** imply:

- merging referral points with partner balance
- automatically injecting promo input into quote/payment flow
- shipping referral public UX before admin-owned exchange truth exists
