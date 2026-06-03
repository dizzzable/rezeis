# Next Session Handoff — Rezeis Remediation

Updated: 2026-06-03

## User Context

The user clarified the intended architecture:

- `rezeis` is the admin panel and stores the system truth.
- `reiwa` is the user-facing runtime where users interact with the service.
- The two services communicate on the same Docker network through API calls.

Do not re-litigate that boundary. The remediation work should preserve it.

## Files Created For Handoff

- `AGENTS.md` — session bootstrap rules, current gates, skills, guardrails.
- `docs/progress/rezeis-remediation-plan.md` — prioritized remediation plan with acceptance criteria.
- This file — short operational handoff for the next session.
- `scripts/update-handoff.mjs` — updates this file's gate snapshot table.
- `package.json` — root handoff scripts only.
- `.githooks/pre-commit` and `.githooks/pre-commit.sample` — optional local hook and matching template; not enabled automatically.

## Handoff Automation

- `npm run handoff:update` from repo root updates the timestamp and marks checks as not run.
- `npm run handoff:update:verify` runs the configured checks and writes the observed pass/fail summary.
- The optional `.githooks/pre-commit` can be enabled manually with `git config core.hooksPath .githooks`; it runs the same trusted backend/web gates as root CI plus `npm run handoff:update`. Audits are tracked in the gate snapshot but remain out of the optional hook to keep local commits fast. `.githooks/pre-commit.sample` is kept in sync as the template copy.
- Do not make the hook mandatory without explicit user approval.

## Continuation Trigger

Start a future session with `продолжение нужно` or `продолжай rezeis` to activate the repo-level continuation instructions in `AGENTS.md`. The next agent should read this handoff, refresh the timestamp with `npm run handoff:update`, check git status, and begin the current Recommended First Slice without asking for another plan.

## Existing Untracked Files To Leave Alone

- `.claude/`
- `IMPROVEMENT_PLAN.md`

These existed before this handoff. Do not overwrite or delete them unless explicitly asked.

## Current Gate Snapshot

Generated: 2026-06-03T21:17:42.241Z (checks not re-run; previous observed results preserved)

Run these from `V:\REZEIS_ADMIN_RUID_USER\rezeis` or the listed subdirectory.

| Area | Command | Last observed result |
| --- | --- | --- |
| Backend Prisma generate | `npm run prisma:generate` in `rezeis-admin` | Pass |
| Backend typecheck | `npm run typecheck` in `rezeis-admin` | Pass |
| Backend lint | `npm run lint` in `rezeis-admin` | Pass |
| Backend tests | `npm test` in `rezeis-admin` | Pass: 513 tests |
| Backend maintained tests | `npm run test:maintained` in `rezeis-admin` | Pass: 423 tests (336 core + 22 admin-surfaces + 65 email-linking) |
| Backend admin surfaces tests | `npm run test:maintained:admin-surfaces` in `rezeis-admin` | Pass: 23 tests |
| Backend admin auth tests | `node --require ts-node/register --test test/admin-auth.service.spec.ts test/auth.controller.spec.ts test/internal-admin.controller.spec.ts test/current-admin.decorator.spec.ts test/current-internal-request.decorator.spec.ts` in `rezeis-admin` | Pass: 22 tests (5 files) |
| Backend config tests | `node --require ts-node/register --test test/auth.config.spec.ts test/email.config.spec.ts test/payments.config.spec.ts test/redis.config.spec.ts test/remnawave.config.spec.ts test/env.schema.spec.ts` in `rezeis-admin` | Pass: 16 tests |
| Backend email service tests | `node --require ts-node/register --test test/email.service.spec.ts` in `rezeis-admin` | Pass: 3 tests |
| Backend Prisma service tests | `node --require ts-node/register --test test/prisma.service.spec.ts` in `rezeis-admin` | Pass: 5 tests |
| Backend safe exception tests | `node --require ts-node/register --test test/admin-safe-exception.filter.spec.ts` in `rezeis-admin` | Pass: 4 tests |
| Backend payment diagnostics tests | `node --require ts-node/register --test test/payment-provider-error.util.spec.ts test/payment-provider-execution.service.spec.ts test/payment-webhook-inbox.service.spec.ts test/payments-checkout.service.spec.ts test/payment-ops-alert-delivery.service.spec.ts` in `rezeis-admin` | Pass: 20 tests |
| Backend payment reconciliation side effects tests | `node --require ts-node/register --test test/payment-reconciliation-notifications.service.spec.ts` in `rezeis-admin` | Pass: 7 tests |
| Backend user activity edge tests | `node --require ts-node/register --test test/user-activity-query.dto.spec.ts test/user-notifications.service.spec.ts test/user-transactions-history.service.spec.ts` in `rezeis-admin` | Pass: 13 tests |
| Backend webhook queue ops tests | `node --require ts-node/register --test test/payment-webhook-ingress.service.spec.ts test/payment-webhook-ops.service.spec.ts` in `rezeis-admin` | Pass: 24 tests |
| Backend internal platform policy tests | `node --require ts-node/register --test test/internal-platform-policy.controller.spec.ts` in `rezeis-admin` | Pass: 6 tests |
| Backend health endpoint tests | `node --require ts-node/register --test test/health.controller.spec.ts test/health.service.spec.ts` in `rezeis-admin` | Pass: 11 tests |
| Backend settings/current contract tests | `node --require ts-node/register --test test/settings.controller.spec.ts test/settings.service.spec.ts test/payment-ops-alert-settings.util.spec.ts` in `rezeis-admin` | Pass: 15 tests |
| Backend web-auth DTO tests | `node --require ts-node/register --test test/web-auth.dto.spec.ts test/web-auth-register-validation.pbt.spec.ts` in `rezeis-admin` | Pass: 13 tests |
| Backend web-auth controller tests | `node --require ts-node/register --test test/web-auth.controller.spec.ts` in `rezeis-admin` | Pass: 6 tests |
| Backend web-auth service/password tests | `node --require ts-node/register --test test/web-auth.service.spec.ts test/web-auth.password-hashing.pbt.spec.ts` in `rezeis-admin` | Pass: 16 tests |
| Backend runtime/request/HTTP tests | `node --require ts-node/register --test test/request-correlation.middleware.spec.ts test/runtime-entrypoints.spec.ts test/api-docs.spec.ts test/app-lifecycle.logger.spec.ts test/bigint-json.spec.ts test/outbound-http-options.spec.ts test/http-runtime.middleware.spec.ts` in `rezeis-admin` | Pass: 23 tests |
| Backend payment gateway registry tests | `node --require ts-node/register --test test/payment-gateway-registry.service.spec.ts` in `rezeis-admin` | Pass: 6 tests |
| Backend plans admin tests | `node --require ts-node/register --test test/plans-admin.service.spec.ts` in `rezeis-admin` | Pass: 4 tests |
| Backend promocode mapper tests | `node --require ts-node/register --test test/plan-record.util.spec.ts` in `rezeis-admin` | Pass: 4 tests |
| Backend profile-sync tests | `node --require ts-node/register --test test/profile-sync-queue.service.spec.ts test/profile-sync.processor.spec.ts` in `rezeis-admin` | Pass: 14 tests |
| Backend payment transaction tests | `node --require ts-node/register --test test/payments-transactions.service.spec.ts test/admin-payment-transactions.controller.spec.ts` in `rezeis-admin` | Pass: 7 tests |
| Backend push tests | `node --require ts-node/register --test test/push.service.spec.ts` in `rezeis-admin` | Pass: 10 tests |
| Backend Remnawave API/node tests | `node --require ts-node/register --test test/remnawave-api.service.spec.ts test/remnawave-node-mapper.spec.ts` in `rezeis-admin` | Pass: 14 tests |
| Backend internal user devices tests | `node --require ts-node/register --test test/internal-user-subscription-devices.service.spec.ts` in `rezeis-admin` | Pass: 5 tests |
| Backend broadcast tests | `node --require ts-node/register --test test/admin-broadcast.service.spec.ts test/admin-broadcast-delivery.service.spec.ts test/admin-broadcast.controller.spec.ts` in `rezeis-admin` | Pass: 15 tests |
| Backend email-linking tests | `node --require ts-node/register --test test/linking.service.spec.ts test/linking.controller.spec.ts test/internal-user.service.spec.ts test/internal-user-linked-web-account-sign-in.spec.ts test/complete-web-account-email-verification.dto.spec.ts` in `rezeis-admin` | Pass: 65 tests |
| Backend audit | `npm audit` in `rezeis-admin` | Pass: found 0 vulnerabilities |
| Web typecheck | `npx tsc -p tsconfig.app.json --noEmit --incremental false` in `rezeis-admin/web` | Pass |
| Web tests | `npm test` in `rezeis-admin/web` | Pass: 12 files, 65 tests |
| Web lint | `npm run lint` in `rezeis-admin/web` | Pass, 26 warnings |
| Web build | `npm run build` in `rezeis-admin/web` | Pass |
| Web audit | `npm audit` in `rezeis-admin/web` | Pass: found 0 vulnerabilities |

## Recommended First Slice

Current recommendation: continue the S7/S5 crossover by deciding whether admin-visible payment provider identifiers (`gatewayId` in transaction rows and `providerEventId` in webhook ops) are acceptable operational fields or need tighter masking/reveal controls, then review `AdminPaymentTransactionsController` for explicit route-level RBAC before any global `RbacGuard` rollout. User-facing/internal payment status payloads were audited and already return bounded fields plus normalized `failureReason` codes. Payment analytics labels and Antilopay provider-declared errors are now redacted. Do not globalize `RbacGuard` yet.

## Completion Estimate And Remaining Work

Overall remediation is approximately 60-65% complete as of 2026-06-03. This is an operational estimate, not a story-point metric: P0 quality gates are complete, deploy safety is mostly complete, admin security is partly complete, and most frontend correctness/accessibility/strictness work is still ahead.

Completed or mostly complete:

- P0 Trustworthy Gates: complete. Backend typecheck/lint/full tests pass, web typecheck/tests/lint/build pass, root CI runs the real gates, and backend/web audits pass.
- P1 Deploy Safety: mostly complete. Compose credentials/network/process-role hardening, Docker ignore hygiene, proxy hardening, and version/release metadata alignment are done. `.env.example` cleanup remains constrained by repo guardrails around `.env.*` files.
- P1 Admin Security: CORS allowlist, report-only CSP rollout, production Swagger shutdown, short-term admin cache/session boundary, API-token RBAC, OAuth-provider RBAC, backup/config-portability/import RBAC, API-token hash/audience/TTL hardening, payment diagnostics provider-response redaction, and webhook-ops RBAC are complete.

Remaining priority order:

- Finish any residual S5 RBAC surface audit route-by-route if a clear gap is found; payment gateway registry RBAC is now closed, but do not globalize `RbacGuard` yet.
- Continue S7/S5 payment hardening: shared payment diagnostic message redaction now covers auth headers, cookies, provider/gateway ID assignments, URL assignments, payment analytics labels, and Antilopay provider-declared errors; `gatewayData.providerResponse` is redacted before persistence; webhook ops are RBAC-gated; webhook detail `includeRaw=true` returns redacted payload while preserving audit logging; public/internal webhook ingress responses no longer echo raw webhook bodies; and the credential-bearing payment gateway settings UI/API surface is behind explicit `payment_gateways:view/edit`. Remaining question: whether admin transaction/webhook provider identifiers should stay visible as operational IDs or require masking/reveal controls and tighter RBAC.
- Revisit S6 API-token per-audience scopes only if more internal clients need separation; the current `rezeis-internal-api` audience, 180-day TTL, hash-only storage, expiration enforcement, and operator rotation UX are done.
- P2 Frontend Correctness And UX: auth readiness, query-key factories/realtime invalidation, production devtools/client-log redaction, critical form schemas, and accessibility baseline.
- P3 TypeScript Strictness: defer broad strictness until the higher-priority security/frontend slices are stable.

P0.1, P0.2, P0.3, and P0.4 are complete: web typecheck/tests/lint/build pass, backend typecheck/lint/full tests pass, root `.github/workflows/ci.yml` now runs full backend `npm test` as the blocking backend test signal, and backend/web audits pass. S1 Admin Security CORS allowlist is complete for runtime/config validation: production now fails closed without `ADMIN_CORS_ORIGINS`, configured origins are normalized and deduplicated, and wildcard/invalid/path-bearing credentialed origins are rejected. S2 CSP Rollout is complete as a production report-only Helmet CSP with explicit SPA directives and no enforcing CSP header yet. S3 Swagger Exposure is complete: `/api/docs` is not mounted in production even when `API_DOCS_ENABLED=true` is accidentally set. S4 Admin Token Storage And Cache Isolation is complete for the short-term frontend boundary: login/logout clear TanStack Query plus sensitive Zustand stores, token access is centralized through `authStorage` with current-tab in-memory fallback when localStorage writes fail, axios/realtime/direct backup download use the same token source, and the legacy OAuth query-string token fallback is removed. S5 RBAC Completion is now in progress: admin API-token management is gated end-to-end with `api_tokens:view/create/delete`, OAuth provider configuration is gated with `auth_providers:view/edit`, and backup/config-portability/import operations are gated on backend routes plus matching frontend tabs/actions. Passkey and TOTP self-service remain JWT-protected account-level surfaces, not global auth-provider administration. S6 API-token hardening is mostly complete: new API tokens are bound to the `rezeis-internal-api` audience, the database persists only `tokenHash`/audience/prefix metadata plus `expiresAt`, internal API verification checks JWT type/audience, timing-safe fingerprint match, and DB expiration while throttling `lastUsedAt` writes, and the operator UI now shows expiry/expired state with safe rotation copy. S7 Payment Diagnostics Sanitization is in progress: shared payment diagnostic redaction now masks auth/proxy-auth headers, cookies, set-cookie values, provider/gateway identifier assignments, provider URL assignments, emails, UUIDs, provider IDs, token words, and long hex secrets before payment ops alerts or diagnostic displays.

Recommended first slice: continue S7/S5 payment hardening by reviewing admin payment transaction/webhook identifier exposure and adding explicit `RbacGuard`/`@RequirePermission` coverage to admin transaction routes if they are currently JWT-only. Do not globalize `RbacGuard` yet; revisit API-token per-audience scopes only if a concrete client split appears.

Latest S1 verification: `node --require ts-node/register --test test/env.schema.spec.ts test/http-runtime.middleware.spec.ts` passed 23 tests; `npm run typecheck` passed; focused ESLint on changed backend files passed.

Latest S2 verification: `node --require ts-node/register --test test/http-runtime.middleware.spec.ts` passed 16 tests; `npm run typecheck` passed; focused ESLint on changed backend files passed.

Latest S3 verification: `node --require ts-node/register --test test/api-docs.spec.ts test/http-runtime.middleware.spec.ts` passed 18 tests; `npm run typecheck` passed; focused ESLint on changed backend files passed.

Latest S4 verification: `npx vitest run src/lib/auth-storage.test.ts src/lib/admin-session.test.ts` passed 7 tests; `npx tsc -p tsconfig.app.json --noEmit --incremental false` passed; focused ESLint on changed web auth/session files passed; `npm test` in `rezeis-admin/web` passed 11 files / 62 tests.

Latest S5 verification: payment gateway registry RBAC slice passed `node --require ts-node/register --test test/admin-payment-gateways.controller.spec.ts test/payment-gateway-registry.service.spec.ts` (8 tests), backend `npm run typecheck`, focused backend ESLint, `npx vitest run src/features/payments/gateway-settings-page.test.tsx` (2 tests), web typecheck, and focused web ESLint. Backup/config-portability/import RBAC slice passed `node --require ts-node/register --test test/admin-backup-rbac.controller.spec.ts test/admin-config-portability-rbac.controller.spec.ts test/imports.controller.spec.ts` (11 tests), `npm run test:maintained:admin-surfaces` (23 tests), backend `npm run typecheck`, focused backend ESLint, `npx vitest run src/features/backup/backup-page.test.tsx src/features/imports/imports-page.test.tsx src/features/config-portability/config-portability-page.test.tsx` (6 tests), S5 web RBAC regression bundle across API tokens/auth providers/backup/imports/config portability (12 tests), web typecheck, and focused web ESLint. Previous OAuth provider RBAC slice passed `node --require ts-node/register --test test/admin-oauth-config.controller.spec.ts` (4 tests), `npx vitest run src/features/settings/auth-providers-tab.test.tsx` (3 tests), backend `npm run typecheck`, backend `npm run lint`, web typecheck/focused lint, and full web `npm test` (13 files / 68 tests). Previous API-token RBAC slice passed `node --require ts-node/register --test test/admin-api-tokens.controller.spec.ts` (4 tests), backend typecheck/lint, `npx vitest run src/features/settings/api-tokens-page.test.tsx` (3 tests), web typecheck/focused lint, and full web `npm test` (12 files / 65 tests).

Latest S6 verification: API-token TTL/rotation slice passed `node --require ts-node/register --test test/api-tokens.service.spec.ts test/internal-admin-auth.guard.spec.ts test/admin-api-tokens.controller.spec.ts` (11 tests), backend `npm run typecheck`, focused backend ESLint, `npx vitest run src/features/settings/api-tokens-page.test.tsx` (3 tests), `npx tsc -p tsconfig.app.json --noEmit --incremental false`, and focused web ESLint. `npm run prisma:generate` was run after adding `ApiToken.expiresAt` to refresh Prisma Client types; it loaded `.env` through Prisma but no secret files were read or printed.

Latest S7 verification: payment analytics/Antilopay redaction slice passed `node --require ts-node/register --test test/payment-analytics.service.spec.ts test/payment-provider-execution.service.spec.ts` (8 tests), `npm run test:maintained:core` (356 tests), backend `npm run typecheck`, and focused ESLint on changed analytics/payment service/spec files. Webhook ingress response redaction slice passed `node --require ts-node/register --test test/payment-webhook-ingress.service.spec.ts test/public-payment-webhooks.controller.spec.ts test/internal-payment-webhooks.controller.spec.ts` (12 tests), backend `npm run typecheck`, and focused ESLint on webhook ingress/interface/spec files. Webhook raw reveal redaction slice passed `node --require ts-node/register --test test/payment-webhook-ops.service.spec.ts test/payment-webhook-payload-redaction.service.spec.ts test/admin-payment-webhooks.controller.spec.ts` (21 tests), backend `npm run typecheck`, and focused ESLint on `src/modules/payments/services/payment-webhook-ops.service.ts` plus `test/payment-webhook-ops.service.spec.ts`. Gateway settings surface audit/RBAC slice passed the S5 payment gateway registry verification above. Previous provider-response/webhook-ops redaction slice passed `node --require ts-node/register --test test/payment-provider-error.util.spec.ts test/payment-provider-execution.service.spec.ts test/payments-checkout.service.spec.ts test/addon-purchase.service.spec.ts test/payment-webhook-inbox.service.spec.ts test/payment-webhook-ops.service.spec.ts test/payment-webhook-payload-redaction.service.spec.ts test/payment-ops-alert-delivery.service.spec.ts test/admin-payment-webhooks.controller.spec.ts` (42 tests), backend `npm run typecheck`, and focused ESLint on changed payment service/controller/spec files.

Historical P0.3 triage notes retained for context:

- Continue backend test triage from current failure groups. Already fixed and verified: config/env tests, `admin-safe-exception.filter.spec.ts`, payment diagnostic tests, current `PaymentProviderExecutionService` checkout/redaction behavior, current `PaymentsTransactionsService` list/draft behavior, current `AdminPaymentTransactionsController` list/draft delegation, current `WebPushService` persistence/delivery behavior, current `InternalPushController` route/delegation behavior, current `EmailService` debug-only verification dispatch and malformed-recipient rejection behavior, `payment-reconciliation-notifications.service.spec.ts`, user activity edge tests, deterministic `payment-webhook-ingress.service.ts` narrow coverage, deterministic `payment-webhook-ops.service.spec.ts`, the internal platform policy / registration-toggle contract, current health controller/service contracts and public health diagnostic redaction, current settings controller/service contracts, current payment-ops alert settings utility contract, current promocodes/referrals service/controller contracts, current promocode mapper/plan snapshot contract, current `PaymentGatewayRegistryService` default-gateway contract, current `PlansAdminService` write/normalization contract, current `ProfileSyncQueueService` and `ProfileSyncProcessor` contracts, current admin auth service/controller/decorator contracts, current `web-auth` DTO validation/recovery behavior, current `InternalWebAuthController` route/delegation behavior, current `WebAuthService`, current scrypt `PasswordHashService` behavior, current Prisma split-env/adapter contract, current Remnawave API/node mapping contracts, current internal user devices controller contracts, current broadcast service/delivery/controller contracts, current linking service/controller contracts, current internal-user email verification/sign-in contracts, current correlation/request logging behavior, runtime API/worker entrypoint contracts, API docs exposure policy, shutdown lifecycle logging, BigInt JSON serialization, bounded outbound HTTP defaults, and HTTP runtime middleware seams.
- The settings/worker stale-contract group is closed for this slice. `settings.controller.spec.ts` and `settings.service.spec.ts` now target current endpoints and `SettingsService` JSON settings behavior; `payment-ops-alert-settings.util.spec.ts` covers the extracted payment-ops settings utility.
- Deleted stale contracts: `settings-notification-delivery.service.spec.ts` targeted notification delivery problem/retry methods that no longer exist on `SettingsService`; `worker-module.spec.ts` targeted the removed dedicated `WorkerModule` split. Current worker behavior is covered by `runtime-entrypoints.spec.ts`: package scripts and `nest-cli.json` expose separate API/worker entrypoints while `src/worker.ts` intentionally loads the full `AppModule` and relies on `RUID_PROCESS_ROLE`.
- The profile-sync stale-contract group is closed for this slice. `profile-sync-queue.service.spec.ts` now targets `src/modules/profile-sync/profile-sync-queue.service.ts`; `profile-sync.processor.spec.ts` covers current CREATE/UPDATE/no-op behavior. Deleted stale contracts: `profile-sync-job-executor.service.spec.ts` targeted the removed payment-owned executor/admin ops surface (`processNextPendingJob`, `listProblemJobs`, compensation notes, force-link); `job-observability.spec.ts` targeted removed `common/observability` and `modules/metrics` contracts plus the old profile-sync executor payload.
- The payment-provider execution stale-contract group is closed for this slice. `payment-provider-execution.service.spec.ts` no longer targets removed `createRefund`; it now covers current checkout request wiring for YooKassa/Heleket/Platega and verifies unexpected raw provider checkout failures are normalized before leaving `PaymentProviderExecutionService`.
- Timeout assertions that were load-sensitive under full-suite pressure were made deterministic in `payment-webhook-ingress.service.spec.ts` and `profile-sync-queue.service.spec.ts` by using never-resolving promises instead of wall-clock `<45ms` checks. Maintained suite passes under load.
- The payment transaction stale-contract group is closed for this slice. `payments-transactions.service.spec.ts` now targets current list/createDraft behavior, including user-search filters, user mapping, quote rejection payloads, TRIAL rejection, device hints, and existing pending draft reuse. `admin-payment-transactions.controller.spec.ts` now targets current list/draft delegation instead of removed refund/manual correction routes.
- The push stale-contract group is closed for this slice. `push.service.spec.ts` now targets current `WebPushService` upsert/unsubscribe/sendToUser behavior, including VAPID-disabled no-op delivery, successful provider sends, permanent endpoint cleanup, transient failure counting, and current `InternalPushController` route/delegation/payload validation.
- The password-recovery stale group is closed for this slice. Deleted stale-only specs targeting removed `InternalUserController` password-recovery/reset endpoints and removed Telegram recovery delivery service: `internal-user-password-recovery.controller.spec.ts`, `internal-user-password-recovery.service.spec.ts`, and `telegram-password-recovery-delivery.service.spec.ts`. Current recovery behavior remains covered by `web-auth.dto.spec.ts`, `web-auth.controller.spec.ts`, and `web-auth.service.spec.ts`.
- The Prisma stale-contract group is closed for this slice. `prisma.service.spec.ts` now targets the current Prisma 7 no-arg provider and split `DATABASE_*` adapter connection behavior, including explicit `DATABASE_URL` fallback.
- The Remnawave stale-contract group is partially closed for this slice. `remnawave-api.service.spec.ts` now targets current direct panel methods (`getPanelUserDevices`, `deletePanelUserDevice`, `updatePanelUser`, `resetPanelUserTraffic`) instead of removed subscription wrapper methods. Real regression fixed: `mapNode` now hides sensitive `lastStatusMessage` values containing URLs/tokens/auth/config/subscription data.
- The internal user devices stale-contract group is closed for this slice. `internal-user-subscription-devices.service.spec.ts` now targets current `InternalUserDevicesController` route/delegation/regenerate behavior instead of removed `InternalUserService.getSubscriptionDevices` / `revokeSubscriptionDevice` methods.
- The admin auth stale-contract group is closed for this slice. `admin-auth.service.spec.ts` now targets the current `AuthConfiguration` (`cryptKey`, no static internal API key), current `AdminAuthService` select/JWT/profile fields (`rbacRoleId`, `mustChangePassword`), and `auth.controller.spec.ts`, `internal-admin.controller.spec.ts`, `current-admin.decorator.spec.ts`, and `current-internal-request.decorator.spec.ts` now target the current controller paths, `username` DTO wiring, TOTP-required mapping, password-change delegation, and current admin profile shape.
- The email service stale-contract group is closed for this slice. `email.service.spec.ts` now targets the current no-constructor `EmailService` verification-code contract instead of removed `smtp-mail-client.service` helpers and removed `sendLinkedAccountPasswordResetLink` behavior. Real regression fixed: `EmailService` now rejects empty or CR/LF recipient addresses before the current debug-only dispatch path.
- The broadcast stale-contract group is closed for this slice. `admin-broadcast.service.spec.ts`, `admin-broadcast-delivery.service.spec.ts`, and `admin-broadcast.controller.spec.ts` now target current `BroadcastService`, `BroadcastDeliveryService`, `broadcast-payload.dto.ts`, and `AdminBroadcastController` behavior: draft list/create/update, audience preview filters, recipient staging, Telegram delivery/finalization, route metadata, DTO validation, queue delegation, and media upload validation. Real regression fixed: `BroadcastDeliveryService` now sanitizes Telegram provider diagnostics before persisting failed message errors or logging edit/delete failures.
- The users/admin stale-contract group is closed for this slice. `admin-user-search-query.dto.spec.ts`, `admin-user-support-message-delivery.service.spec.ts`, `admin-users.service.spec.ts`, `admin-users.controller.spec.ts`, and `admin-users.http.spec.ts` now target current split users/admin controllers, DTOs, and service contracts; verified as 18 passing tests.
- The health stale-contract group is closed for this slice. `health.controller.spec.ts` and `health.service.spec.ts` now target the current unauthenticated `/health`, `/health/live`, and `/health/ready` contract instead of removed Terminus queue-readiness/status helpers. Real regression fixed: public health responses no longer expose raw database URLs, Redis URLs, tokens, or local backup paths in component `details`; sanitized diagnostics are kept in bounded logs.
- The email-linking stale-contract group is closed for this slice. `linking.service.spec.ts` and `linking.controller.spec.ts` now target current `src/modules/linking/services/linking.service` and `InternalLinkingController`; `internal-user.service.spec.ts`, `internal-user-linked-web-account-sign-in.spec.ts`, and `complete-web-account-email-verification.dto.spec.ts` now cover current internal-user email verification/sign-in behavior. Deleted stale-only specs that imported removed `src/modules/linking/email-verification.service`, old cache-backed linking code behavior, or duplicate email controller coverage. Real regressions fixed: duplicate normalized linked emails are rejected before issuing a challenge or sending mail, exhausted email-link challenges are filtered/consumed on final wrong attempt, and compensating revoke failures now attach only a stable sanitized marker instead of raw diagnostics.
- The api-docs/app-lifecycle/bigint-json/outbound-http/http-runtime stale-contract group is closed for this slice. Current seams now live under `src/common/http`, `src/common/lifecycle`, and `src/common/runtime`; `main.ts` gates Swagger behind `API_DOCS_ENABLED`, installs bounded rawBody-aware parsers, no-robots/helmet/correlation middleware, bounded outbound HTTP defaults, and centralizes CORS/proxy settings through validated config. Maintained suite now covers these contracts.
- The final stale-contract group is closed for this slice. `backup.service.spec.ts`, `dashboard.controller.spec.ts`, `dashboard.service.spec.ts`, `imports.controller.spec.ts`, `imports.service.spec.ts`, `internal-user-activity.controller.spec.ts`, and `internal-user.controller.spec.ts` now target current runtime contracts. Deleted stale-only specs: `governance.controller.spec.ts`, `governance.service.spec.ts`, and `internal-device-provisioning.controller.spec.ts`.
- Full backend `npm test` is now trustworthy enough to block CI again.

## Important Findings To Keep In Mind

- Root `.github/workflows/ci.yml` and `.github/workflows/docker-publish.yml` are active; nested `rezeis-admin/.github/workflows/*` is not active for this repository layout.
- Root CI now runs full backend `npm test` as a blocking backend test signal.
- Backend tests are now trustworthy enough for CI. Real regressions around env parsing, safe exception output, payment diagnostics, payment transaction list/draft behavior, push subscription/delivery behavior, provider checkout failure redaction, payment reconciliation side effects, webhook queue failure bounds, Remnawave node status redaction, internal platform policy behavior, current settings behavior, health diagnostic redaction, current promocodes/referrals behavior, current payment gateway defaults, plans unarchive/update normalization, profile-sync queue/processor behavior, current email verification dispatch validation, current email-linking duplicate/attempt/revoke-sanitization behavior, current web-auth behavior, current password hashing, request correlation/log sanitization, runtime API/worker scripts, API docs exposure, shutdown lifecycle logging, BigInt JSON serialization, bounded outbound HTTP defaults, and HTTP runtime middleware were fixed or reverified in current slices.
- Previous stale specs were deleted only after confirming the runtime contract was removed: old metrics modules, old user-activity queue/bot/event modules, old web-registration settings, old web-auth challenge/recovery/property contracts, old internal-user password recovery/reset endpoints, old Telegram password recovery delivery service, old settings notification-delivery retry methods, old dedicated worker module graph, old profile-sync executor/admin ops surface, old job observability/metrics modules, old `EmailVerificationService` contracts, old cache-backed linking code properties, duplicate old linking email controller specs, removed governance module specs, and removed internal-device-provisioning controller specs.
- Latest full-suite run passes: 513 tests. P0.4 audit triage is closed: backend audit passes after overriding Prisma dev-tooling `@hono/node-server` to `1.19.13`, and web audit passes after overriding transitive `node-fetch` to `2.7.0` while keeping `face-api.js` for `GridScan` webcam tracking.
- The previous load-sensitive `payment-webhook-ops.service.spec.ts`, `payment-webhook-ingress.service.spec.ts`, and profile-sync queue timeout assertions were made deterministic by using stalled promises instead of wall-clock completion flags; maintained suite now passes under load.
- React Query cache and sensitive client stores are now cleared on admin login/logout boundaries, closing the short-term shared-browser cross-admin cache exposure. The longer-term HttpOnly-cookie/BFF session migration is still open.
- Admin JWT is still a bearer token persisted in `localStorage` when available, with a same-tab in-memory fallback when writes fail. OWASP guidance still recommends not storing session identifiers or sensitive auth data there, so this remains a later architecture/security follow-up.
- API token management now has explicit `api_tokens:view/create/delete` backend RBAC and matching frontend list/create/revoke gates. `api_tokens` is intentionally not granted to default operator/support/finance system roles. New API tokens are audience-bound to `rezeis-internal-api`, expire after 180 days, are stored only as SHA-256 fingerprints at rest, and are verified with a timing-safe fingerprint plus DB expiration check; legacy no-`aud` JWTs continue to validate only if their migrated fingerprint row remains present and has not expired.
- Payment gateway registry endpoints now require `payment_gateways:view` for list/detail/supported-currency reads and `payment_gateways:edit` for update/move/default seeding. The gateway settings nav/page no longer fetches credential-bearing gateway settings without `payment_gateways:view`, and renders existing gateways read-only without `payment_gateways:edit`.
- Payment analytics provider failure labels and webhook top-error labels are now redacted before response serialization, so historical/raw provider status strings or `last_error` values do not leak URLs, tokens, emails, provider IDs, or Redis/DB URLs through broadly visible `analytics:view` reports.
- Antilopay non-zero provider responses now redact provider-declared error text before throwing `BadRequestException`; the numeric provider code remains for operations.
- Admin webhook event detail requests with `includeRaw=true` now still write the payload-reveal audit log but return the redacted payload instead of the stored unredacted webhook body.
- Public/internal payment webhook ingress responses no longer include the normalized envelope or raw webhook body; raw payload persistence in the inbox remains unchanged for reconciliation/audit.
- Credentialed admin CORS no longer reflects arbitrary origins: `ADMIN_CORS_ORIGINS` is required in production and invalid/wildcard origins are rejected. Helmet CSP now emits `Content-Security-Policy-Report-Only` in production with explicit SPA directives; it is intentionally not enforcing yet. Swagger is disabled in production even when `API_DOCS_ENABLED=true`; outside production it still requires explicit `API_DOCS_ENABLED=true`.
- `docker-compose.yml` no longer hardcodes production DB/Redis credentials; it now requires generated `DATABASE_PASSWORD` and `REDIS_PASSWORD`. `.env.example` still needs explicit approval because current repo guardrails prohibit reading/editing `.env.*`. DB/Redis now attach only to the internal `rezeis-private` network; app/worker remain on both `rezeis-private` and external `remnawave-network` for proxy/Reiwa reachability.
- `docker-compose.yml` now sets `RUID_PROCESS_ROLE=api` on the API service and `RUID_PROCESS_ROLE=worker` on the worker service. `.env.example` may still need cleanup after explicit approval to read/edit `.env.*` files.
- `.dockerignore` now excludes env files, certs/keys, runtime data, uploads, backups, SQL/dump/tar artifacts, logs, coverage, package-manager caches, and scratch directories from Docker build context.
- Root `deploy/proxies` is now canonical. Traefik no longer mounts Docker socket, dashboard/debug are disabled, `traefik:v3.3` is pinned, and dev-only `cloudflare/cloudflared:2025.8.1` is pinned. Nested `rezeis-admin/deploy/proxies` is marked legacy/reference-only.
- Docker/release metadata now aligns on `0.7.3`: Dockerfile accepts `APP_VERSION` and `GIT_SHA`, docker-publish passes package version and commit SHA as build args, health responses include `version` and non-sensitive `gitSha`, and README/docs image examples use unified `ghcr.io/dizzzable/rezeis` tags.

## Internet Research Used

- GitHub Actions docs: workflows are discovered only from repository-root `.github/workflows`.
- OWASP HTML5 Security Cheat Sheet: localStorage is not appropriate for session identifiers/sensitive auth; CORS should use explicit trusted origins.
- Docker Compose secrets docs: secrets avoid exposing passwords/API keys through environment variables.
- Docker rootless docs: non-root/container rootless mode reduces daemon/runtime blast radius.
- Helmet docs: CSP defaults exist; report-only mode can help roll out a policy safely.
- Nest deployment docs: health checks are production monitoring endpoints, and logs must avoid sensitive data such as passwords or tokens.
- TanStack Query docs: `queryClient.clear()` clears all connected caches.
- OWASP Secrets Management Cheat Sheet: secrets should have lifecycle metadata, least-privilege access, rotation/revocation/expiration handling, and should not be exposed broadly at rest.
- OWASP REST Security Cheat Sheet: API keys should be required on protected endpoints, revocable, not used alone for high-value user authentication, and sensitive tokens should not be sent in URLs; JWT consumers should validate issuer/audience/expiration where applicable.
- OWASP API2:2023 Broken Authentication: microservices should not rely on weak/predictable tokens, tokens must be validated, and API keys are for API-client authentication rather than user authentication.
- NIST SP 800-63B-4: verifiers should use authenticated protected channels, rate limit authentication attempts, and store verifier secrets in forms resistant to offline attacks.
- OWASP Logging Cheat Sheet: logs and diagnostics should remove, mask, sanitize, hash, or encrypt access tokens, session identifiers, database connection strings, secrets, payment data, and sensitive identifiers before storage/display.
- OWASP Error Handling Cheat Sheet: user-facing errors should be generic and avoid implementation/detail leakage, while server-side diagnostics must be controlled and sanitized.
- NestJS authorization/guards docs: route-level authorization should use guards plus handler metadata; current session attempted external fetches, but the web fetch returned only the docs page title and Exa search/fetch returned 401, so the implementation followed the local mirrored official Nest docs already present in the workspace.

Future sessions should proactively use web search/fetch for current official docs, advisories, and standards before security, deploy, framework, browser-platform, dependency, or audit/remediation decisions, unless the exact source is already freshly captured here. Record any newly used source in this section.

## Suggested Skills For Next Session

- Load `nestjs-platform` for CORS/CSP/Swagger/config/health/deploy work.
- Load `nestjs-core` for guard/module/provider refactors.
- Load `react-state` for auth provider, logout/login cache reset, Zustand/TanStack Query boundaries.
- Load `react-effects` for realtime/socket/service-worker lifecycle fixes.
- Load `typescript-config` for tsconfig/build strictness work.
- Load `accessibility` for skip links, landmarks, focus behavior, dialogs.

Skill loading is expected, not optional, when the work matches a listed skill. For the next recommended RBAC/admin-security slice, load `nestjs-core`, `nestjs-platform`, and the relevant React skill before editing.

## Do Not Start With

- Full backend `strictNullChecks` conversion.
- Global `RbacGuard` conversion before every admin route has explicit metadata and tests.
- Making pre-commit hooks mandatory without explicit user approval.
- Rewriting the rezeis/reiwa service boundary.
