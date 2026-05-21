# Referral Bounded Context — First Slice Proposal

## Purpose

This note describes the smallest safe implementation slice for adding referral
business logic to `rezeis-admin` so that later `G1` gift-promocode exchange work
can be implemented without mixing responsibilities across services.

It does not claim that the module below already exists in the repo.

## Proposed Ownership

`rezeis-admin` owns:

- referral invite issuance and revoke logic
- referral graph truth (`referrer -> referred`)
- referral qualification after successful purchase completion
- referral reward issuance and exchange balance calculation
- any future referral exchange workflow

`ruid` may later mirror only:

- referral dashboard reads
- invite link / QR presentation
- user-triggered exchange requests that call narrow internal admin contracts

## First Safe Module Shape

Recommended first slice under `rezeis-admin/src/modules/referrals/`:

- `controllers/`
  - `admin-referrals.controller.ts`
  - `internal-referrals.controller.ts`
- `services/`
  - `referral-graph.service.ts`
  - `referral-invites.service.ts`
  - `referral-qualification.service.ts`
  - `referral-rewards.service.ts`
  - `referral-exchange.service.ts`
- `dto/`
  - invite create/list DTOs
  - referral summary DTOs
  - exchange request / response DTOs

## Minimal Internal Contracts

The first internal contracts should be enough to support operator checks and a
future thin `ruid` edge:

- `GET /api/internal/referrals/summary?userId=...`
  - returns referral points / qualification / invite summary
- `POST /api/internal/referrals/invites`
  - creates a referral invite token for a user
- `POST /api/internal/referrals/exchange/gift-promocode`
  - debits referral points and returns created gift promocode details

## Minimal Exchange Transaction Requirements

`referral-exchange.service.ts` should perform one admin-owned transaction that:

1. resolves the requesting user's exchangeable referral balance
2. validates exchange type and target plan
3. debits referral points
4. creates the resulting reward artifact
5. writes an exchange outcome / audit snapshot

For gift-promocode exchange, the resulting artifact should be one `PromoCode`
using the existing promo slice with:

- generated code
- `rewardType = SUBSCRIPTION`
- `rewardValue = durationDays`
- `planSnapshot = selected plan snapshot`
- `maxActivations = 1`

## Recommended Order

1. invite issuance + referral summary
2. referral qualification after successful purchase completion
3. referral reward balance calculation
4. gift-promocode exchange endpoint
5. thin `ruid` dashboard / exchange edge

## Deliberate Exclusions For First Slice

Do not couple the first referral slice to:

- partner balance
- payment draft creation
- quote calculation
- broader loyalty / campaign engines

Keep the first slice narrowly admin-owned so `G1` can later become a small,
safe follow-on instead of a multi-domain rewrite.
