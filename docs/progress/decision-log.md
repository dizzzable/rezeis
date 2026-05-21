# Decision Log

## Established Decisions

### 2026-04-23: `rezeis/ruid` is the canonical Pyright and basedpyright analysis root

- `rezeis/ruid` is now the authoritative analysis root for Pyright and basedpyright because it is already a self-contained Python project with its own `pyproject.toml`.
- Workspace-root diagnostics are only treated as authoritative when the checker is invoked with `--project rezeis/ruid`; workspace-root runs without an explicit project selector are not accepted as evidence for this package.
Files:
- `rezeis/ruid/pyproject.toml`
- `docs/progress/decision-log.md`

### 2026-04-22: AltShop subscription devices / HWID Phase 1 is the next bounded donor slice

- Recovery work is treated as closed for planning purposes, so the next donor slice returns to subscription behavior instead of more recovery expansion.
- The current repo already exposes a narrow read seam: `rezeis-admin` remains the source of truth through `InternalUserService.getSubscription()` and `GET /api/internal/user/subscription`, which currently return only the passive snapshot fields `id`, `status`, `isTrial`, `plan`, `trafficLimit`, `deviceLimit`, `configUrl`, `startedAt`, `expiresAt`, `createdAt`, and `updatedAt`.
- `ruid` mirrors that seam at `GET /api/v1/subscription` through `SubscriptionService` and authenticated cookie-session lookup, while `ruid/web` treats subscription as read-only and consumes it through `useSubscriptionQuery()` with shared query key `['subscription']`.
- Phase 1 scope is intentionally strict: current subscription device list, revoke or remove of a recorded device, device count and device limit visibility, and blocked or max-devices messaging.
- Explicit exclusions stay in force: no assignment changes, no regenerated subscription or config links, no broad subscription lifecycle rewrite, no quote or payment coupling, and no speculative Remnawave or browser-side contract usage.
- `@remnawave/backend-contract` stays a typed schema and route-metadata dependency inside `rezeis-admin`; server-side HTTP orchestration still runs through the admin facade and must not be described as a contract-package HTTP client.
Files:
- `docs/architecture/altshop-business-logic-transfer.md`
- `docs/architecture/service-boundaries.md`
- `docs/architecture/altshop-subscription-devices-phase-1.md`
- `docs/progress/current-status.md`
- `docs/progress/next-milestone.md`

### 2026-04-22: reset-by-link and reset-by-telegram-code completion paths are aligned

- `resetWebAccountPasswordByLink` now distinguishes consumed vs never-issued/expired tokens via a consumed-state fallback check using a new `getLatestPasswordResetTokenChallenge` helper, which mirrors the pattern already present in `resetWebAccountPasswordByTelegramCode`.
- This provides aligned developer diagnostics and consistent error semantics: consumed tokens now return `PASSWORD_RESET_LINK_ALREADY_USED_MESSAGE` while never-issued or expired tokens still return `INVALID_OR_EXPIRED_PASSWORD_RESET_LINK_MESSAGE`.
- Anti-enumeration behavior stays unchanged: users receive stable error responses in both cases, just with a slightly more precise message for the consumed state.
Files:
- `rezeis-admin/src/modules/internal-user/services/internal-user.service.ts`
- `rezeis-admin/test/internal-user-password-recovery.service.spec.ts`
- `docs/progress/current-status.md`
- `docs/progress/next-milestone.md`

### 2026-04-22: Telegram-assisted password recovery phase 3 is shipped as admin-owned code completion

- `rezeis-admin` now also owns `POST /api/internal/user/web-account/password-reset-by-telegram-code`, keeping password mutation and Telegram code validation inside the same admin-owned password-reset truth already used by phase 1 and phase 2.
- Telegram-issued password-reset challenges now carry `codeHash` and `tokenHash`, so Telegram delivery and Telegram code completion stay on one admin-owned challenge model instead of creating a second recovery state.
- `ruid` mirrors that completion at `POST /api/v1/auth/web-account/password-reset-by-telegram-code`, and `ruid/web` now ships `/reset-password-telegram` as the minimal completion page linked from `/forgot-password` for users who already received a Telegram code.
- The full Telegram recovery trilogy stays intentionally bounded: all Telegram phases still reuse the same admin-owned password-reset truth, still preserve anti-enumeration behavior, and still remain limited to already linked users whose bot chat already exists because they already started the bot.
Files:
- `rezeis-admin/src/modules/internal-user/`
- `ruid/app/api/endpoints/auth.py`
- `ruid/app/services/internal_admin_client.py`
- `ruid/web/src/features/auth/`
- `docs/progress/current-status.md`
- `docs/progress/next-milestone.md`
- `docs/architecture/service-boundaries.md`
- `ruid/SPEC.md`

### 2026-04-21: Telegram-assisted password recovery phase 2 is shipped as the narrow continuation of phase 1

- `rezeis-admin` now also owns `POST /api/internal/user/web-account/password-recovery/telegram`, which reuses the same admin-owned password-reset truth as phase 1 instead of creating a second recovery state.
- Telegram delivery stays intentionally narrow: the continuation only works for linked users whose bot chat already exists because they already started the bot, and anti-enumeration behavior stays unchanged.
- `ruid` mirrors that continuation at `POST /api/v1/auth/web-account/password-recovery/telegram`, and `ruid/web` exposes it only as a secondary `/forgot-password` action with explicit copy about the existing bot-chat precondition.
Files:
- `rezeis-admin/src/modules/internal-user/`
- `ruid/app/api/endpoints/auth.py`
- `ruid/app/services/internal_admin_client.py`
- `ruid/web/src/features/auth/`
- `docs/progress/current-status.md`
- `docs/progress/next-milestone.md`
- `docs/architecture/service-boundaries.md`
- `ruid/SPEC.md`

### 2026-04-21: standalone password recovery phase 1 is shipped as the base for the later Telegram continuation

- `rezeis-admin` now owns `POST /api/internal/user/web-account/password-recovery` and `POST /api/internal/user/web-account/password-reset-by-link`, including anti-enumeration-safe recovery initiation, `AuthChallenge` token validation, password update, and reset-link email delivery.
- `ruid` mirrors that flow at `POST /api/v1/auth/web-account/password-recovery` and `POST /api/v1/auth/web-account/password-reset-by-link`, and `ruid/web` now ships `/forgot-password` plus `/reset-password` linked from `/sign-in`.
- This supersedes the prior "standalone password recovery is next" framing and became the base the later same-day Telegram continuation reused.
Files:
- `rezeis-admin/src/modules/internal-user/`
- `ruid/app/api/endpoints/auth.py`
- `ruid/app/services/internal_admin_client.py`
- `ruid/web/src/features/auth/`
- `docs/progress/current-status.md`
- `docs/progress/next-milestone.md`

### 2026-04-21: activity slice is shipped; next auth milestone is standalone password recovery

- The activity vertical is now treated as shipped across `rezeis-admin`, `ruid`, and `ruid/web`, including notification acknowledgement and payment-driven notification event writes.
- This supersedes prior transitional status framing and moves the next user-auth milestone to standalone password recovery (outside reopening via Telegram launch context).
- Public activity notification acknowledgements intentionally accept only narrow read sources (`MANUAL` and `BULK`) at the `ruid` edge.
Files:
- `rezeis-admin/src/modules/user-activity/`
- `ruid/app/api/endpoints/user_activity.py`
- `ruid/app/schemas/user_activity.py`
- `docs/progress/current-status.md`
- `docs/progress/next-milestone.md`

### 2026-04-20: promocode business truth stays admin-owned and `ruid` remains a thin promo edge

- `rezeis-admin` owns promo CRUD, code normalization, activation validation, activation history, reward execution decisions, audit trail, structured metrics events, and write permission gates.
- `ruid` mirrors only the user-authenticated promo activation / history / branching-support contract and must not become the source of truth for promo state.
- Promo activation supports branching outcomes (`NONE`, `SELECT_SUBSCRIPTION`, `CREATE_NEW`) and preserves admin-owned error-code semantics through the public edge.
Files:
- `rezeis-admin/src/modules/promocodes/`
- `rezeis-admin/web/src/features/promocodes/`
- `ruid/app/api/endpoints/promocode.py`
- `ruid/app/services/promocode_service.py`
- `ruid/app/schemas/promocode.py`
- `ruid/web/src/features/promo/`
- `docs/architecture/service-boundaries.md`

### 2026-04-20: referral points and partner balance remain separate ledgers

- Referral rewards and referral exchange are user-growth incentives and must not be treated as cash-like partner balance.
- Partner balance remains a ledger-like money state with its own accrual, withdrawal, and settlement rules.
- Any future referral gift-promocode flow must consume referral-domain inputs explicitly and must not reuse partner-balance semantics or storage.
Files:
- `docs/architecture/altshop-business-logic-transfer.md`
- `docs/progress/current-status.md`

### 2026-04-20: promo activation remains separate from purchase quote until business explicitly merges them

- Current Rezeis transfer keeps promo activation as a dedicated flow (`/promocode`) instead of injecting promo input into quote/payment creation.
- Any future `G2` work must be treated as an explicit business-scope expansion, not as an automatic follow-on from the shipped promo slice.
Files:
- `docs/architecture/altshop-business-logic-transfer.md`
- `docs/progress/current-status.md`

### 2026-04-20: referral foundation first slice is now admin-owned, but exchange stays deferred

- `rezeis-admin` now ships a first referral foundation slice for summary reads and invite create/revoke operations.
- This does not yet include exchange settlement or gift-promocode issuance.
- Future referral exchange work must build on this bounded context rather than bypassing it.
Files:
- `rezeis-admin/src/modules/referrals/`
- `rezeis-admin/test/referrals.controllers.spec.ts`
- `rezeis-admin/test/referral-services.spec.ts`
- `docs/progress/current-status.md`
- `docs/progress/promocodes-blockers.md`

### 2026-04-19: Payment Ops Center owns webhook diagnostics, safe replay, reconciliation health, and Telegram alert sink

- `rezeis-admin` now exposes admin-only payment ops endpoints for webhook event listing/detail, audited raw payload reveal, manual safe replay, and reconciliation health.
- Webhook event lifecycle is now typed and observable with reconciliation/replay counters plus transition timestamps.
- Telegram alerts are configured through `Settings.systemNotifications.paymentOps`, use the existing `BOT_TOKEN`, and send summary-plus-link messages for failed webhook and replay actions.
- Raw payload is redacted by default in UI; explicit reveal is audited.
Files:
- `rezeis-admin/prisma/schema.prisma`
- `rezeis-admin/src/modules/payments/`
- `rezeis-admin/src/modules/settings/`
- `rezeis-admin/web/src/features/payments/`
- `rezeis-admin/prisma/migrations/20260419000000_init/migration.sql`

### 2026-04-19: `rezeis-admin/web` now has local Vitest smoke coverage and a canonical quality gate sequence

- `rezeis-admin/web` now runs `vitest` locally with jsdom setup and shared test utilities, covering router smoke plus the shipped admin verticals (`catalog`, `payments`, `subscriptions`, `remnawave`).
- The quality gate is now documented as one canonical pre-commit sequence across all three services, and includes `rezeis-admin/web` test + build instead of build-only validation.
- This is a hardening-only change: external/public API contracts are unchanged.
Files:
- `rezeis-admin/web/package.json`
- `rezeis-admin/web/vite.config.ts`
- `rezeis-admin/web/src/test/setup-tests.ts`
- `rezeis-admin/web/src/test/test-utils.tsx`
- `rezeis-admin/web/src/app/router.smoke.test.tsx`
- `rezeis-admin/web/src/features/catalog/plans-page.smoke.test.tsx`
- `rezeis-admin/web/src/features/payments/payment-gateways-page.smoke.test.tsx`
- `rezeis-admin/web/src/features/payments/payment-transactions-page.smoke.test.tsx`
- `rezeis-admin/web/src/features/subscriptions/subscription-quote-page.smoke.test.tsx`
- `rezeis-admin/web/src/features/remnawave/remnawave-page.smoke.test.tsx`
- `docs/progress/current-status.md`
- `docs/progress/local-quality-gate.md`

### 2026-04-19: live payment flow starts in `ruid` but executes and reconciles only in `rezeis-admin`

- `ruid/web` starts payment only from `/quote`, and `/payments/result` is the dedicated return/polling surface.
- `ruid` mirrors checkout/status only; it does not own provider execution, webhook handling, or subscription mutation.
- `rezeis-admin` executes provider checkout creation, accepts payment webhooks, enqueues reconciliation, and mutates subscription truth after completed payment.
Files:
- `rezeis-admin/src/modules/payments/`
- `ruid/app/api/endpoints/payments.py`
- `ruid/web/src/features/payments/`
- `ruid/web/src/features/quote/quote-page.tsx`

### 2026-04-19: payment webhook ingress and dedup stay admin-owned and execution-disabled

- `rezeis-admin` now owns both `POST /api/v1/payments/webhooks/:gatewayType` and `POST /api/internal/payments/webhooks/:gatewayType`, with one normalization pipeline and one inbox/dedup layer.
- Inbox dedup is keyed by `gatewayType + providerEventId`, and providers without a stable event id fall back to `paymentId` for `providerEventId`.
- `ruid` remains read-only for plans/subscription/quote and does not gain payment write endpoints during this hardening step.
Files:
- `rezeis-admin/src/modules/payments/`
- `rezeis-admin/prisma/schema.prisma`
- `docs/architecture/service-boundaries.md`
- `docs/progress/current-status.md`
- `ruid/SPEC.md`

### 2026-04-19: public quote edge is session-only, read-only, and admin-owned

- `rezeis-admin` now exposes internal quote reads at `POST /api/internal/subscriptions/action-policy` and `POST /api/internal/subscriptions/quote` behind the existing internal API key guard.
- `ruid` mirrors those routes at `POST /api/v1/subscription/action-policy` and `POST /api/v1/subscription/quote`, always sources `userId` from the authenticated cookie session, and rejects client attempts to pass `userId` in payload.
- `ruid/web` now has a dedicated `/quote` route that supports all five actions (`NEW`, `ADDITIONAL`, `RENEW`, `UPGRADE`, `TRIAL`) for read-only eligibility and price preview, without transaction draft creation or payment execution.
Files:
- `rezeis-admin/src/modules/subscriptions/controllers/internal-subscriptions.controller.ts`
- `rezeis-admin/src/modules/subscriptions/subscriptions.module.ts`
- `ruid/app/schemas/subscription_quote.py`
- `ruid/app/services/subscription_service.py`
- `ruid/app/api/endpoints/subscription.py`
- `ruid/web/src/features/quote/quote-api.ts`
- `ruid/web/src/features/quote/quote-page.tsx`
- `ruid/web/src/app/router.tsx`
- `ruid/tests/test_subscription_endpoints.py`
- `ruid/tests/test_internal_admin_client.py`

### 2026-04-19: plans/catalog/pricing is now a real admin-owned vertical slice

- `rezeis-admin` now exposes a dedicated `plans` module with JWT-protected admin CRUD routes and an internal catalog projection at `GET /api/internal/catalog/plans`.
- The plan model now carries explicit archived renew policy and canonical UUID-based transition / allowlist references instead of AltShop-legacy numeric arrays.
- `ruid` switched its plans read path from `GET /api/internal/user/plans` to the new catalog route and keeps `GET /api/v1/plans` public while opportunistically using the cookie session for discount-aware pricing.
- `rezeis-admin/web` now has a real `/catalog/plans` route with operator CRUD and nested duration/price editing instead of a placeholder section.
Files:
- `rezeis-admin/prisma/schema.prisma`
- `rezeis-admin/src/modules/plans/`
- `rezeis-admin/web/src/features/catalog/`
- `ruid/app/api/endpoints/plans.py`
- `ruid/app/services/plans_service.py`
- `ruid/app/schemas/plans.py`
- `ruid/web/src/features/plans/plans-api.ts`
- `ruid/web/src/features/plans/plans-page.tsx`

### 2026-04-18: backend linked web-account sign-in now preserves admin-owned credentials and RUID-owned cookie sessions

- `rezeis-admin` exposes `POST /api/internal/user/web-account/sign-in` behind the internal API key guard.
- The admin service verifies linked web-account login/password, rejects missing credentials, forced password-change state, unverified email, blocked users, and invalid credentials, then returns the same canonical internal session payload used by existing `ruid` flows.
- `ruid` mirrors that at `POST /api/v1/auth/web-account/sign-in`, maps invalid credentials to `401`, maps not-ready linked account states to stable `400` responses, and writes the same opaque Redis-backed `ruid_session` cookie used by Telegram bootstrap.
- `ruid/web` exposes `/sign-in`, submits linked credentials through the public mirror, invalidates session/subscription/platform-policy queries, and returns to the authenticated shell on success.
Files:
- `rezeis-admin/src/modules/internal-user/controllers/internal-user.controller.ts`
- `rezeis-admin/src/modules/internal-user/dto/linked-web-account-sign-in.dto.ts`
- `rezeis-admin/src/modules/internal-user/services/internal-user.service.ts`
- `ruid/app/api/endpoints/auth.py`
- `ruid/app/schemas/linked_web_account_sign_in.py`
- `ruid/app/services/internal_admin_client.py`
- `ruid/app/services/session_service.py`
- `ruid/web/src/app/router.tsx`
- `ruid/web/src/features/auth/sign-in-page.tsx`
- `ruid/web/src/features/auth/auth-api.ts`
- `ruid/web/src/features/auth/auth-required-state.tsx`
- `rezeis-admin/test/internal-user-linked-web-account-sign-in.spec.ts`
- `ruid/tests/test_auth_endpoints.py`
- `ruid/tests/test_internal_admin_client.py`
- `ruid/web/src/features/auth/sign-in-page.test.tsx`

### 2026-04-18: repo refresh revalidates that the shipped edge is still Telegram-first and that standalone linked-account sign-in is still the next milestone

- `ruid` still exposes only `POST /api/v1/auth/telegram/bootstrap` under the auth router, while authenticated writes remain under `/api/v1/session`.
- `ruid/web` still routes only `/`, `/plans`, `/subscription`, and `/web-account`, and the unauthenticated state still instructs users to reopen the Mini App instead of using a standalone sign-in screen.
- The next repo-grounded milestone therefore remains standalone linked web-account sign-in through `ruid`, with credential verification still owned by `rezeis-admin`.
Files:
- `ruid/app/api/router.py`
- `ruid/app/api/endpoints/auth.py`
- `ruid/app/api/endpoints/session.py`
- `ruid/web/src/app/router.tsx`
- `ruid/web/src/app/router.test.tsx`
- `ruid/web/src/features/auth/auth-api.ts`
- `ruid/web/src/features/auth/auth-required-state.tsx`
- `docs/progress/current-status.md`
- `docs/progress/next-milestone.md`

### 2026-04-18: status refresh confirms the shipped public auth surface is still Telegram bootstrap only

- `ruid` still exposes only `POST /api/v1/auth/telegram/bootstrap` as a public auth entrypoint.
- `ruid/web` still routes only `/`, `/plans`, `/subscription`, and `/web-account`, and the unauthenticated shell still directs users to reopen the Mini App instead of offering a standalone sign-in screen.
- The next milestone therefore remains standalone linked web-account sign-in, not broader billing or entitlement work.
Files:
- `ruid/app/api/endpoints/auth.py`
- `ruid/app/api/router.py`
- `ruid/web/src/app/router.tsx`
- `ruid/web/src/features/auth/auth-required-state.tsx`
- `ruid/web/src/features/auth/auth-provider.tsx`
- `docs/progress/current-status.md`
- `docs/progress/next-milestone.md`

### 2026-04-18: refreshed progress keeps standalone linked web-account sign-in as the next repo-grounded milestone

- The shipped public surface still consists of Telegram bootstrap plus cookie-backed reads and current-session writes; there is still no public non-Telegram sign-in route in `ruid`.
- Linked web-account password handoff, challenge issuance, and verification completion are already live end to end, so the next missing user-facing slice is standalone sign-in for that prepared linked account.
- This preserves the boundary already established in the repo: `rezeis-admin` keeps owning credential verification and account truth, while `ruid` keeps owning browser-facing session issuance and public auth orchestration.
Files:
- `ruid/app/api/endpoints/auth.py`
- `ruid/web/src/features/auth/auth-api.ts`
- `ruid/web/src/features/auth/auth-provider.tsx`
- `ruid/web/src/features/auth/auth-required-state.tsx`
- `ruid/web/src/app/router.tsx`
- `ruid/web/src/features/web-account/web-account-page.tsx`
- `docs/progress/current-status.md`
- `docs/progress/next-milestone.md`

### 2026-04-18: verification completion is shipped, but the canonical ownership docs still lag the current write surface

- `docs/architecture/service-boundaries.md` still stops at challenge issuance in the documented internal contract.
- `ruid/SPEC.md` still documents only four authenticated session writes and omits `PATCH /api/v1/session/web-account-email-verification-completion`.
- The progress docs should keep calling out this drift until the ownership docs are refreshed alongside the next auth milestone.
Files:
- `docs/architecture/service-boundaries.md`
- `ruid/SPEC.md`
- `ruid/app/api/endpoints/session.py`
- `ruid/web/src/features/session/session-api.ts`

### 2026-04-18: linked-email verification completion is live through the full public edge

- `ruid` mirrors `PATCH /api/internal/user/session/web-account-email-verification-completion` at `PATCH /api/v1/session/web-account-email-verification-completion`.
- `ruid/web` submits the verification code from `/web-account`, refreshes the canonical session payload on success, and clears the local pending challenge state.
- This does not move ownership. `rezeis-admin` still owns linked-account truth, challenge validation, and verification outcomes, while `ruid` stays the thin public edge.
Files:
- `ruid/app/api/endpoints/session.py`
- `ruid/app/services/session_service.py`
- `ruid/app/services/internal_admin_client.py`
- `ruid/app/schemas/session_web_account_email_verification_completion.py`
- `ruid/web/src/features/session/session-api.ts`
- `ruid/web/src/features/web-account/web-account-page.tsx`
- `ruid/web/src/features/dashboard/dashboard-page.tsx`
- `ruid/tests/test_session_endpoints.py`
- `ruid/tests/test_internal_admin_client.py`
- `ruid/web/src/features/web-account/web-account-page.test.tsx`

### 2026-04-18: admin-side linked-email verification completion is real, but it remains admin-owned

- `rezeis-admin` exposes `PATCH /api/internal/user/session/web-account-email-verification-completion` alongside challenge issuance.
- The internal service validates the latest active code challenge, decrements attempts on invalid codes, marks `AuthChallenge.consumedAt`, and sets `WebAccount.emailVerifiedAt` on success.
- Public mirroring exists, but domain ownership still stays in `rezeis-admin`.
Files:
- `rezeis-admin/src/modules/internal-user/controllers/internal-user.controller.ts`
- `rezeis-admin/src/modules/internal-user/services/internal-user.service.ts`
- `rezeis-admin/src/modules/internal-user/dto/complete-web-account-email-verification.dto.ts`
- `rezeis-admin/prisma/schema.prisma`
- `rezeis-admin/test/internal-user.service.spec.ts`
- `rezeis-admin/test/internal-user.controller.spec.ts`

### 2026-04-18: linked-email challenge issuance depends on admin-side SMTP delivery

- `rezeis-admin` sends the verification code through a dedicated SMTP-backed email service after issuing the challenge.
- The env contract explicitly requires `REZEIS_ADMIN_SMTP_*` settings on admin-side deployments, and challenge issuance revokes freshly created challenges on known delivery failures.
- This keeps email delivery admin-owned and avoids pushing SMTP concerns into `ruid`.
Files:
- `rezeis-admin/src/modules/email/services/email.service.ts`
- `rezeis-admin/src/common/config/env.schema.ts`
- `rezeis-admin/test/email.service.spec.ts`
- `rezeis-admin/test/email.config.spec.ts`
- `rezeis-admin/test/env.schema.spec.ts`
- `.env.example`
- `.env.dev.example`
- `.env.external.admin.example`
- `docs/install/environment-variables.md`

### 2026-04-17: the shipped public write surface includes linked email-verification challenge issuance

- `rezeis-admin` exposes `PATCH /api/internal/user/session/web-account-email-verification-challenge` and persists one active `AuthChallenge` for the linked `WebAccount`.
- `ruid` mirrors that write at `PATCH /api/v1/session/web-account-email-verification-challenge`.
- `ruid/web` exposes the issuance CTA on both the dashboard and `/web-account`, and keeps pending challenge state local until `challengeExpiresAt` passes.
Files:
- `rezeis-admin/src/modules/internal-user/controllers/internal-user.controller.ts`
- `rezeis-admin/src/modules/internal-user/services/internal-user.service.ts`
- `rezeis-admin/prisma/schema.prisma`
- `ruid/app/api/endpoints/session.py`
- `ruid/app/services/session_service.py`
- `ruid/app/services/internal_admin_client.py`
- `ruid/web/src/features/dashboard/dashboard-page.tsx`
- `ruid/web/src/features/web-account/web-account-page.tsx`
- `ruid/web/src/features/web-account/get-web-account-visibility-state.ts`

### 2026-04-17: the shipped public write surface includes password handoff, rules acceptance, and reminder snooze

- `rezeis-admin` exposes `PATCH /api/internal/user/session/rules-acceptance`, `PATCH /api/internal/user/session/web-account-link-prompt-snooze`, and `PATCH /api/internal/user/session/web-account-password`.
- `ruid` mirrors those writes at `PATCH /api/v1/session/rules-acceptance`, `PATCH /api/v1/session/web-account-link-prompt-snooze`, and `PATCH /api/v1/session/web-account-password`.
- `ruid/web` consumes the refreshed session payload directly after each authenticated write, and `/web-account` is a shipped route rather than a planned one.
Files:
- `rezeis-admin/src/modules/internal-user/controllers/internal-user.controller.ts`
- `rezeis-admin/src/modules/internal-user/services/internal-user.service.ts`
- `ruid/app/api/endpoints/session.py`
- `ruid/app/services/session_service.py`
- `ruid/web/src/features/session/session-api.ts`
- `ruid/web/src/features/dashboard/dashboard-page.tsx`
- `ruid/web/src/features/web-account/web-account-page.tsx`
- `ruid/web/src/app/router.tsx`

### 2026-04-16: `rezeis-admin` remains the business truth

- `rezeis-admin` owns customer, subscription, billing, entitlement, and operator-managed truth.
- `ruid` remains a thin public edge and must not reimplement those rules.
Files:
- `docs/architecture/service-boundaries.md`
- `ruid/SPEC.md`

### 2026-04-16: platform settings stay admin-owned and writable only through the admin API

- The singleton settings record is managed in `rezeis-admin` through JWT-protected admin routes.
- `ruid` consumes only the user-safe read-only projection of that state.
Files:
- `rezeis-admin/src/modules/settings/controllers/settings.controller.ts`
- `rezeis-admin/src/modules/settings/services/settings.service.ts`
- `rezeis-admin/src/modules/settings/controllers/internal-platform-policy.controller.ts`
- `ruid/app/services/platform_policy_service.py`

### 2026-04-16: `ruid/web` is Telegram-first, not query-string identity first

- The current user shell bootstraps from Telegram `initData`.
- `POST /api/v1/auth/telegram/bootstrap` exchanges that launch context for an opaque cookie session.
- Session and subscription pages use the authenticated cookie session instead of `userId`, `telegramId`, or `email` query parameters.
Files:
- `ruid/SPEC.md`
- `ruid/app/api/endpoints/auth.py`
- `ruid/web/src/features/auth/auth-provider.tsx`
- `ruid/web/src/features/auth/auth-required-state.tsx`

### 2026-04-16: session state is Redis-backed and cookie-based

- `ruid` stores opaque auth sessions in Redis.
- Bootstrap replay protection is also stored in Redis.
- Cookie behavior is deployment-sensitive and documented per compose and env mode.
Files:
- `ruid/app/services/session_store.py`
- `ruid/app/api/dependencies.py`
- `ruid/app/api/endpoints/auth.py`
- `docs/install/deployment-modes.md`
- `docs/install/environment-variables.md`

### 2026-04-16: browser-origin allowlist is normalized once and reused for CORS plus Telegram bootstrap checks

- `ruid` derives trusted browser origins from `RUID_PUBLIC_WEB_URL` plus `RUID_BROWSER_ALLOWED_ORIGINS`.
- Origins are normalized to `scheme://host[:port]` and reused both for `CORSMiddleware` and for `POST /api/v1/auth/telegram/bootstrap` origin validation.
Files:
- `ruid/app/core/config.py`
- `ruid/app/main.py`
- `ruid/app/api/dependencies.py`
- `ruid/tests/test_settings.py`
- `ruid/tests/test_internal_admin_client.py`

### 2026-04-16: stale upstream users invalidate the local `ruid` session instead of leaving a bad cookie alive

- `GET /api/v1/session`, `GET /api/v1/subscription`, and the authenticated session write routes clear the Redis session and cookie when `rezeis-admin` no longer recognizes the user or the local session payload is corrupt.
- Non-actionable linked-account writes fall back to a refreshed session read instead of leaving the frontend on a stale optimistic assumption.
Files:
- `ruid/app/api/endpoints/session.py`
- `ruid/app/api/endpoints/subscription.py`
- `ruid/app/services/session_store.py`
- `ruid/tests/test_session_endpoints.py`
- `ruid/tests/test_internal_admin_client.py`

### 2026-04-16: deployment mode does not change ownership boundaries

- Single-stack and split deployment are infrastructure choices only.
- The same admin-truth and thin-edge ownership split applies in both modes.
Files:
- `docs/architecture/service-boundaries.md`
- `docs/install/deployment-modes.md`
- `docker-compose.yml`
- `docker-compose.external.admin.yml`
- `docker-compose.external.user.yml`
