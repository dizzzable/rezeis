# Decision Log

## Established Decisions

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
