# AltShop Business Logic Transfer Map

Updated from local `altshop-1.5.0` source inspection on 2026-04-19.

## Purpose

This document maps the business logic that Rezeis should inherit from AltShop.
It is intentionally scoped to business behavior, not Python implementation details.

Rezeis ownership target:

- `rezeis-admin` owns business truth, persistence, control-plane operations, billing,
  subscription lifecycle, Remnawave integration policy, and operator workflows.
- `ruid` owns Telegram bot delivery, Mini App/browser orchestration, public user access,
  cookie/session edge behavior, and presentation-shaped BFF responses.
- `altshop-1.5.0` is the business-logic donor.
- `backend-main` / Remnawave is the integration and NestJS architecture donor.

## AltShop Runtime Shape

AltShop is a Python 3.12 application with:

- FastAPI public API under `/api/v1`
- aiogram Telegram bot and aiogram-dialog operator dashboard
- React/Vite web app and Telegram Mini App shell
- SQLAlchemy/Alembic persistence
- Taskiq workers and scheduled jobs
- PostgreSQL plus Valkey/Redis
- Remnawave as the VPN panel integration

The important lesson is that AltShop already separated many business workflows into
services even though its operator admin UI lives mostly in Telegram. Rezeis should
preserve the service boundaries but move control-plane ownership into NestJS.

## Domain Model To Preserve

AltShop persistence contains these business areas:

| Area | AltShop Tables | Rezeis Target |
| --- | --- | --- |
| Users and identity | `users`, `web_accounts`, `auth_challenges` | `User`, `WebAccount`, `AuthChallenge` in `rezeis-admin` |
| Subscriptions | `subscriptions` | `Subscription` plus Remnawave profile/cache state |
| Plans and pricing | `plans`, `plan_durations`, `plan_prices` | `Plan`, `PlanDuration`, `PlanPrice` |
| Payments | `transactions`, `payment_gateways`, `payment_webhook_events` | `Transaction`, `PaymentGateway`, `PaymentWebhookEvent` |
| Promocodes | `promocodes`, `promocode_activations` | `PromoCode`, `PromoCodeActivation` |
| Referrals | `referral_invites`, `referrals`, `referral_rewards` | `ReferralInvite`, `Referral`, `ReferralReward` |
| Partner program | `partners`, `partner_referrals`, `partner_transactions`, `partner_withdrawals` | `Partner`, `PartnerReferral`, `PartnerTransaction`, `PartnerWithdrawal` |
| Settings | `settings` | singleton `Settings` |
| Notifications | `user_notification_events` plus settings JSON | `UserNotificationEvent` plus settings JSON |
| Broadcasts | `broadcasts`, `broadcast_messages` | `Broadcast`, `BroadcastMessage` |
| Analytics | `web_analytics_events` | `WebAnalyticsEvent` |
| Backups | `backup_records` | `BackupRecord` |

The current Rezeis Prisma schema already mirrors most of this shape. The main gap is
not schema coverage, but implemented services and workflows.

## Business Workflows To Transfer

### 1. Access Policy

AltShop logic:

- access modes: `PUBLIC`, `INVITED`, `PURCHASE_BLOCKED`, `REG_BLOCKED`, `RESTRICTED`
- rules acceptance
- channel membership checks with short Redis cache
- invited-mode grandfathering for existing users
- purchase gating separate from read access
- privileged users bypass user-facing restrictions

Rezeis placement:

- `rezeis-admin`: authoritative settings and policy decisions.
- `ruid`: public enforcement and user-facing explanation of unmet requirements.

Transfer target:

- Promote the current platform-policy slice into a full access-policy module.
- Keep the user-safe read projection for `ruid`.
- Add explicit admin-side tests for each access mode.

### 2. Web Account And Identity

AltShop logic:

- username/login normalization
- web-only shadow users with negative Telegram IDs
- Telegram-linked users
- token versioning
- email verification
- password reset by email link/code
- password reset by Telegram code
- Telegram link request/confirm flows
- merge and cleanup rules for provisional/shadow accounts

Rezeis placement:

- `rezeis-admin`: credentials, password verification, email verification, account merge rules.
- `ruid`: public login/session issuance, Telegram bootstrap, Mini App orchestration.

Transfer target:

- Finish standalone linked web-account sign-in first.
- Add password reset and Telegram link flows after sign-in is stable.
- Preserve the distinction between web login and Telegram identity.

### 3. Plans, Pricing, And Catalog

AltShop logic:

- active/archived plans
- plan types: traffic, devices, both, unlimited
- plan availability: all, new, existing, invited, allowed, trial
- durations and gateway-specific prices
- archived plan renew behavior
- allowed user and allowed plan restrictions
- plan snapshots stored into subscriptions and transactions

Rezeis placement:

- `rezeis-admin`: catalog CRUD, pricing rules, availability decisions.
- `ruid`: read-only catalog projection and purchase UI shaping.

Transfer target:

- Implement `plans` module before payment/subscription purchase.
- Keep plan snapshots immutable once written into subscription/transaction state.

### 4. Subscription Lifecycle

AltShop logic:

- new purchase
- renew
- multi-renew
- upgrade
- additional subscription
- trial eligibility and trial creation
- subscription assignment changes: plan and device type
- soft delete / status changes
- runtime refresh from Remnawave
- device list, generated subscription URL, HWID revoke
- current subscription selection and cache invalidation

Rezeis placement:

- `rezeis-admin`: subscription truth, lifecycle state machine, Remnawave sync decisions.
- `ruid`: user-facing subscription reads and request orchestration.

Transfer target:

- The next donor slice is intentionally smaller than the full AltShop lifecycle: `subscription devices / HWID Phase 1`.
- Start from the current passive subscription read seam. `rezeis-admin` already exposes `GET /api/internal/user/subscription`, `ruid` already mirrors `GET /api/v1/subscription`, and `ruid/web` already consumes that read-only snapshot. See `docs/architecture/altshop-subscription-devices-phase-1.md`.
- Phase 1 scope is limited to the current subscription device list, recorded-device revoke or remove, device count and device limit visibility, and blocked or max-devices messaging.
- Leave assignment changes, regenerated subscription or config links, quote or payment coupling, and broader lifecycle rewrites out of this slice.
- After Phase 1, keep the longer-term goal: implement subscription service as a state machine, not scattered controller logic.
- Use background jobs for Remnawave writes and runtime refresh once broader lifecycle work begins.
- Keep Remnawave profile/cache failures from corrupting local business truth.

### 5. Purchase And Payment Flow

AltShop logic:

- purchase quote before execution
- final pricing with personal/purchase discounts
- settlement currency and crypto assets
- explicit or implicit gateway selection
- partner-balance purchases
- external payment creation
- transactions with purchase context, renew IDs, device types, plan snapshots
- webhook inbox/deduplication via `payment_webhook_events`
- post-payment orchestration: mark transaction, provision/renew subscription, referral reward,
  partner earning, notifications
- cancel stale pending transactions
- recover stuck Platega webhooks

Supported gateway concepts:

- Telegram Stars
- YooKassa
- YooMoney
- Cryptomus
- Heleket
- CryptoPay
- TBank
- Robokassa
- Stripe
- MulenPay
- CloudPayments
- Pal24 / PayPalych
- WATA
- Platega

Rezeis placement:

- `rezeis-admin`: gateway configuration, payment creation, webhook verification, transaction state,
  post-payment business effects.
- `ruid`: user-facing quote/purchase entrypoint and return handling.

Transfer target:

- Implement payment gateway registry before individual providers.
- Implement webhook inbox/deduplication before enabling live providers.
- Add providers incrementally, starting with Telegram Stars and one external redirect provider.

### 6. Promocodes

AltShop logic:

- reward types: duration, traffic, devices, subscription, personal discount, purchase discount
- availability rules: all, new, existing, invited, allowed
- lifetime and max activation limits
- remaining uses
- allowed users and allowed plan IDs
- activation snapshots
- branching activation result:
  - immediate success
  - select subscription
  - create new subscription
- discount rewards mutate user purchase/personal discount

Rezeis placement:

- `rezeis-admin`: promo validation, activation records, reward execution.
- `ruid`: user-facing activation flow and next-step rendering.

Transfer target:

- Implement promo validation before UI.
- Preserve branching result contracts so Mini App can guide users through selection.
- Keep pre-purchase promo-code input out of the quote/payment path until there is an explicit business decision to merge promo activation with purchase quoting. Current Rezeis transfer keeps promo activation as its own flow.

### 7. Referrals

AltShop logic:

- referral code/link generation
- invites with source: bot, web, unknown
- invite limits and revoke/unrevoked invite state
- attach referral manually or from invite
- qualification after purchase
- rewards: points and extra days
- exchange referral points into subscription days, gift subscription, discounts, traffic
- QR generation for web/Telegram targets

Rezeis placement:

- `rezeis-admin`: referral graph, qualification, rewards, exchange execution.
- `ruid`: invite links, QR, referral dashboard presentation.

Transfer target:

- Implement referral identity and invite system before exchange.
- Keep reward issuance tied to successful purchase completion, not payment creation.
- Current repo note (2026-04-20): Prisma already contains `Referral`, `ReferralInvite`, and `ReferralReward` models, but there is no shipped `rezeis-admin` referral module/service/controller slice yet. This means AltShop gift-promocode exchange behavior cannot be ported as a thin wiring step; Rezeis still needs a first referral bounded-context implementation before `G1` can be completed safely.
- Minimum bounded-context required before `G1` implementation is safe:
  - a referral service that can resolve the caller's exchangeable referral balance/points,
  - a referral exchange service that debits points atomically and persists an exchange outcome,
  - at least one admin/internal endpoint contract for executing the exchange,
  - reward issuance rules that remain separate from partner-balance accounting.

### 8. Partner Program

AltShop logic:

- separate partner profile from referral graph
- partner levels 1/2/3
- accrual strategies: first payment or each payment
- reward types: percent and fixed amount
- partner balance and total earned/withdrawn
- partner referrals and earnings history
- withdrawals with requested currency, quote rate, method, requisites, admin status
- partner balance can be used as payment source

Rezeis placement:

- `rezeis-admin`: partner settings, accrual, balance ledger, withdrawals, admin processing.
- `ruid`: partner portal reads and withdrawal request entrypoint.

Transfer target:

- Treat partner balance as ledger-like money state.
- Do not couple partner accrual directly to referral points; they are related but separate systems.

### 9. Remnawave Integration

AltShop logic:

- Remnawave user/profile CRUD and lookup
- panel sync by plan
- group/squad resolution
- runtime subscription refresh
- node and user webhook event handling
- device count and HWID event updates
- fallback raw HTTP calls for SDK gaps
- profile lookup by Telegram/web user context

Rezeis placement:

- `rezeis-admin`: integration policy, credentials, sync jobs, webhooks, authoritative reconciliation.
- `ruid`: no Remnawave credentials or direct business decisions.

Transfer target:

- Implement an adapter module around Remnawave first.
- Separate raw client, SDK client, sync orchestration, and webhook handling.
- Store local sync state and tolerate Remnawave outages.
- `@remnawave/backend-contract` is useful for typed command schemas and route metadata, but `rezeis-admin` must keep server-side HTTP orchestration in its own admin facade. The contract package is not the HTTP client.
- Do not move Remnawave contract usage into `ruid` or `ruid/web`.

### 10. Notifications, Broadcasts, And Ops

AltShop logic:

- user notification events persisted for web
- Telegram delivery tasks
- system/operator notifications
- expiry/limited/trial/purchase/referral/partner notification templates
- broadcast records and message statuses
- automatic and manual backup
- restore with manifest and recovery from panel profiles
- importer from panel/exported users
- update/release notifications
- runtime assets and translations sync

Rezeis placement:

- `rezeis-admin`: notification/event truth, broadcast ownership, backup/import operations.
- `ruid`: delivery through Telegram bot and user notification reads.

Transfer target:

- Add event records before adding delivery workers.
- Build backup/import after core models stabilize.

## Current Rezeis Coverage

Already present in Rezeis:

- Core Prisma models for most AltShop business entities.
- Admin auth and login-first admin credentials.
- Internal API key contract.
- `internal-user` session, plans, subscription, rules acceptance, web-account password handoff,
  email verification challenge, and email verification completion.
- Platform settings and user-safe platform policy projection.
- Admin user search.
- The first real plans/catalog/pricing vertical slice:
  - Prisma-aligned plan fields for archived renew policy and UUID-based transition references
  - `rezeis-admin` plans module with admin CRUD and internal catalog projection
  - gateway-aware catalog pricing composed at read time from active payment gateways
  - `/catalog/plans` operator UI in `rezeis-admin/web`
  - session-aware public `/api/v1/plans` read in `ruid`
- The current subscription read seam, which is still passive snapshot only:
  - `rezeis-admin` `InternalUserService.getSubscription()` plus `GET /api/internal/user/subscription`
  - payload fields: `id`, `status`, `isTrial`, `plan`, `trafficLimit`, `deviceLimit`, `configUrl`, `startedAt`, `expiresAt`, `createdAt`, `updatedAt`
  - `ruid` mirror at `GET /api/v1/subscription` through `SubscriptionService`
  - `ruid/web` read-only usage through `useSubscriptionQuery()` and shared React Query key `['subscription']`
- Deployment modes for one VPS and split admin/user VPS.

Missing or incomplete:

- Linked-account self-service follow-up beyond the shipped standalone sign-in and recovery routes, plus Telegram account linking.
- Subscription device or HWID write surface and the broader lifecycle or purchase state machine.
- Payment gateway registry, gateway config UI, payment creation, webhook inbox handling.
- Promocode validation/execution.
- Referral invites/rewards/exchange.
- Partner accrual, balance, withdrawal workflow.
- Remnawave adapter/sync/webhook modules.
- Broadcast/notification/backup/import modules.
- Queue/scheduler architecture in `rezeis-admin`.

## Recommended Transfer Order

1. Stabilize current Rezeis foundation.
   - Keep `rezeis-admin` tests green.
   - Repair `ruid/web` test drift.
   - Refresh stale ownership docs after each shipped slice.

2. Complete identity bridge.
   - Standalone linked web-account sign-in.
   - Password reset.
   - Telegram link and account merge policies.

3. Build Remnawave adapter foundation.
   - Credentials/settings.
   - Health/read probes.
   - User/profile lookup.
   - Sync job model and webhook validation.

4. Build subscription lifecycle in bounded slices.
   - Current subscription state.
   - Subscription devices / HWID Phase 1.
   - Trial.
   - New/renew/upgrade/additional flows.
   - Runtime refresh and broader device operations.

5. Build payment infrastructure.
   - Gateway registry.
   - Transaction lifecycle.
   - Webhook inbox/deduplication.
   - First live gateway.
   - Post-payment provisioning.

6. Build growth systems.
   - Promocodes.
   - Referrals.
   - Partner program.

7. Build operator systems.
   - Notifications.
   - Broadcast.
   - Backup/restore.
   - Import.
   - Release/update diagnostics.

## NestJS Architecture Guidance For Rezeis

Use Remnawave backend architecture as the NestJS donor, but do not copy its full
complexity before Rezeis needs it.

For each substantial business module, prefer:

```text
Controller -> Service / Use Case -> Repository -> Prisma
                         |
                         -> Queue / Event when side effects are async
```

Introduce CQRS selectively for high-branching workflows:

- purchase execution
- payment webhook processing
- subscription provisioning
- Remnawave sync
- broadcast delivery
- backup/restore

Keep direct Prisma calls acceptable only in small modules. Once a service starts
orchestrating several state transitions or external calls, split data access and
workflow steps.

## Risks To Preserve

- Do not move business truth into `ruid`.
- Do not let payment creation imply subscription provisioning; provisioning belongs after confirmed payment.
- Do not implement live payment webhooks without durable deduplication.
- Do not make Remnawave the only source of subscription truth; Rezeis owns business state and reconciles with Remnawave.
- Do not merge referral and partner systems; they overlap but have different accounting semantics.
- Do not copy AltShop's Python service-file shape one-to-one into NestJS. Transfer behavior and tests, not file layout.
- Keep shadcn/ui as the real UI component source for new admin and user screens.

## Source Files Inspected

Primary AltShop sources:

- `docs/01-project-overview.md`
- `docs/02-architecture.md`
- `docs/03-services.md`
- `docs/04-database.md`
- `docs/05-api.md`
- `docs/07-payment-gateways.md`
- `docs/project-audit-2026-04-12.md`
- `src/core/enums.py`
- `src/infrastructure/database/models/sql/*`
- `src/infrastructure/database/models/dto/*`
- `src/infrastructure/database/repositories/*`
- `src/services/*`
- `src/api/endpoints/*`
- `src/infrastructure/taskiq/tasks/*`
- `src/bot/middlewares/*`
- `tests/core/*`
- `tests/services/*`

Primary Rezeis comparison sources:

- `rezeis-admin/prisma/schema.prisma`
- `rezeis-admin/src/modules/*`
- `ruid/app/api/endpoints/*`
- `ruid/web/src/app/router.tsx`
- `docs/architecture/service-boundaries.md`
- `docs/progress/current-status.md`
- `docs/progress/next-milestone.md`
