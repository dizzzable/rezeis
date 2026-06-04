# Rezeis Remediation Plan

Updated: 2026-06-03

This plan supersedes the optimistic `IMPROVEMENT_PLAN.md` as the actionable remediation sequence. It is based on local audit results plus public references from GitHub Actions, OWASP, Docker, Helmet, and TanStack Query docs.

## Objective

Bring Rezeis from a working runtime to a trustworthy production-grade admin/control-plane by restoring gates first, then hardening deploy/security, then improving code quality.

## Current Reality

- The app can be operational, and the P0 quality gates are now trustworthy enough to block CI.
- Backend typecheck/lint/full tests pass after stale-contract triage.
- Web typecheck/tests/lint/build pass after fixing the `Plan.icon` fixture; backend and web audits now pass after P0.4 dependency override triage.
- Root CI now runs backend/web quality gates plus full backend `npm test` from `.github/workflows/ci.yml`.
- Security posture has concrete issues: localStorage admin JWT, open credentialed CORS, disabled CSP, public Swagger, long-lived API tokens, hardcoded compose secrets, shared DB/Redis network.

## P0 — Trustworthy Gates

Goal: make the repository able to say “green” or “red” truthfully before larger refactors.

### P0.1 Fix Web Typecheck And Build

Status: Completed 2026-06-02. The `Plan` fixture includes `icon: null`; verified with web typecheck, tests, lint, and build.

Files:

- `rezeis-admin/web/src/features/plans/plans-api.test.ts`
- `rezeis-admin/web/src/features/plans/plans-api.ts`

Work:

- Add `icon: null` or a valid icon payload to `Plan` fixtures, unless the actual API contract should make `Plan.icon` optional.
- Run web production gates.

Acceptance:

- `cd rezeis-admin/web && npx tsc -p tsconfig.app.json --noEmit --incremental false`
- `cd rezeis-admin/web && npm test`
- `cd rezeis-admin/web && npm run build`

### P0.2 Move Active CI To Repository Root

Status: Completed 2026-06-03. Root `.github/workflows/ci.yml` runs backend `prisma:generate`, typecheck, lint, full backend tests, and web typecheck, tests, lint, build.

Files:

- `.github/workflows/ci.yml`
- `.github/workflows/docker-publish.yml`
- Existing nested `rezeis-admin/.github/workflows/*` for reference only

Work:

- Create root CI with `working-directory: rezeis-admin` for backend and `working-directory: rezeis-admin/web` for web.
- Include backend `npm ci`, `npm run typecheck`, `npm run lint`.
- Include web `npm ci`, typecheck, tests, lint, build.
- Keep backend `npm test` as a separate allowed-failure or non-blocking job until P0.3 completes; do not pretend it is green.

Acceptance:

- GitHub Actions would discover the workflow from root `.github/workflows`.
- Docker publish is not the only root workflow.
- Docker publish is documented as depending on green CI once P0.3 is complete.

External basis:

- GitHub Actions docs require workflow files under repository-root `.github/workflows`.

### P0.3 Triage Backend Test Suite

Status: Completed 2026-06-03. Full backend `npm test` now passes: 513 tests. The final stale-contract slice retargeted backup, dashboard, imports, internal-user, and internal-user activity specs to current runtime contracts; deleted stale-only governance and internal-device-provisioning specs after confirming their runtime modules were removed; and promoted full backend `npm test` into root CI as the blocking backend test signal. `npm run test:maintained` remains as a smaller explicitly maintained suite and now passes 423 tests (336 core + 22 admin-surfaces + 65 email-linking).

Historical triage notes below are kept for context.

Latest override 2026-06-03: `npm run test:maintained` now passes 401 tests (336 core + 65 email-linking), and full `npm test` is known-red at 501 tests / 491 pass / 10 fail. The api-docs/app-lifecycle/bigint-json/outbound-http/http-runtime stale-contract group is closed. Current seams now live under `src/common/http`, `src/common/lifecycle`, and `src/common/runtime`; `main.ts` gates Swagger behind `API_DOCS_ENABLED`, installs bounded rawBody-aware parsers, no-robots/helmet/correlation middleware, bounded outbound HTTP defaults, and centralizes CORS/proxy settings through validated config. Remaining useful stale targets are backup/dashboard/governance/imports/internal-user/activity/device provisioning compile-error groups.

Previous override 2026-06-03: `npm run test:maintained` passed 385 tests (320 core + 65 email-linking), and full `npm test` was known-red at 490 tests / 475 pass / 15 fail. The email-linking stale-contract group is closed. `linking.service.spec.ts` and `linking.controller.spec.ts` now target current `src/modules/linking/services/linking.service` and `InternalLinkingController`; `internal-user.service.spec.ts`, `internal-user-linked-web-account-sign-in.spec.ts`, and `complete-web-account-email-verification.dto.spec.ts` cover current internal-user email verification/sign-in behavior. Deleted stale-only specs that imported removed `src/modules/linking/email-verification.service`, old cache-backed linking code flow, or duplicate email controller specs. Real regressions fixed: `LinkingService.emailInitiate` rejects duplicate normalized linked emails before issuing challenges/sending mail; `LinkingService.emailVerify` filters exhausted challenges and consumes the challenge when wrong attempts reach zero; compensating email verification revoke failures attach only a stable sanitized marker.

Status override 2026-06-02: the latest observed full backend suite is 382 tests / 335 pass / 47 fail. `npm run test:maintained` now passes 242 tests and includes current promocodes/referrals, promocode mapper, payment gateway registry, plans admin write contracts, profile-sync queue/processor contracts, current `PaymentProviderExecutionService` checkout/redaction contracts, current payment transaction list/draft controller/service contracts, current push subscription/delivery contracts, current Prisma split-env/adapter behavior, current Remnawave API/node mapper behavior, and current internal user devices controller behavior. The payment-provider execution group was triaged from the removed refund executor contract to current checkout behavior, and raw unexpected provider errors are now normalized before leaving `createCheckout`. The payment-transactions group was triaged from removed refund/correction/dispute/reconciliation contracts to current `PaymentsTransactionsService` list/createDraft behavior and current `AdminPaymentTransactionsController` list/draft delegation. The push group was triaged from the removed `PushService` / `pushSubscription` / `webAccount` contract to current `WebPushService` and `InternalPushController` behavior. The password-recovery group was removed after confirming the `InternalUserController` recovery/reset endpoints and Telegram recovery delivery service no longer exist; current recovery channel behavior remains covered by `InternalWebAuthController` / `WebAuthService`. The Prisma group now targets the current no-arg Prisma 7 provider and split `DATABASE_*` connection URL construction. The Remnawave group now targets current direct panel APIs instead of removed subscription wrapper methods, and a real node-status leakage regression was fixed by redacting URL/token/auth/config/subscription-bearing `lastStatusMessage` values in `mapNode`. The internal user devices group now targets `InternalUserDevicesController` instead of removed `InternalUserService` device methods. Backend `npm run typecheck` and `npm run test:maintained` pass. Next concrete blocker: `test/admin-auth.service.spec.ts` fails to compile because its mock auth config is missing the current required `cryptKey` field.

Status: In progress. Current full `npm test` is still known-red, but the latest observed run improved to 311 tests / 232 pass / 79 fail after the runtime/request slice. `npm run test:maintained` now passes 128 tests and is promoted into blocking root CI. The maintained suite covers config/env, safe exceptions, payment diagnostics/reconciliation/webhook ops, current user activity notification/feed/history seams, the internal platform policy registration-toggle contract, current web-auth DTO validation/controller behavior, current `WebAuthService`, the current scrypt `PasswordHashService` contract, request correlation/log sanitization, and runtime API/worker entrypoint contracts. Real regressions fixed or reverified so far: boolean env defaults in the central schema, safe exception path/request-id/message redaction, core payment diagnostics redaction for webhook inbox/checkout status/payment ops alerts, payment reconciliation side-effect `markFailed` diagnostics, deterministic webhook queue timeout tests, current user activity notification/feed/history seams, webhook queue timeout/enqueue failure bounds for ingress and replay ops, registration-toggle behavior now derived from platform policy `accessMode`, web-auth DTO validation now targeting class-validator `WebAuthRegisterDto` with `login` plus plain `password` instead of the old `RegisterSchema` / `username` / `passwordHash` contract, web-auth controller coverage now targeting `InternalWebAuthController` / `InternalAdminAuthGuard` instead of the old `WebAuthController` / `InternalApiGuard` / request-IP contract, service-level web-auth coverage now targeting `src/modules/web-auth/services/web-auth.service.ts` plus `PasswordHashService` instead of the old bcrypt/SHA-256 challenge flow, and runtime scripts now expose explicit API/worker start commands. The old `web-registration-settings`, web-auth challenge TTL/recovery confirmation, duplicate-username property, registration-toggle enforcement property, register-creates-account property, sign-in-correctness property, and metrics specs were removed or replaced after documenting that they targeted removed modules, removed handlers, or stale runtime contracts. Remaining work is mostly stale-contract compile failures in settings/worker and broader stale admin/users/email/linking/referrals/remnawave/promocode groups.

Files:

- `rezeis-admin/test/**/*.spec.ts`
- `rezeis-admin/package.json`

Work:

- Split failures into stale-contract tests vs real regressions.
- Delete/archive tests that target removed modules only when there is no runtime contract left.
- Fix tests that reveal real issues: safe exception path/request-id redaction, payment diagnostics, env validation expectations, runtime entrypoints.
- Decide whether property-based tests should be a separate script.

Acceptance:

- `cd rezeis-admin && npm test` passes.
- `cd rezeis-admin && npm run test:maintained` passes as the explicit maintained subset.
- CI runs the full backend test suite as a blocking gate.

Do not:

- Blanket skip failing tests without documenting why each skipped group is stale.

### P0.4 Audit Triage

Status: Completed 2026-06-03. Backend `npm audit` now passes without downgrading Prisma by overriding the transitive Prisma dev-tooling `@hono/node-server` package to `1.19.13`. Web `npm audit` now passes while preserving the existing `GridScan` webcam face-tracking feature by overriding transitive `node-fetch` to `2.7.0` under `face-api.js` / TensorFlow.

Files:

- `rezeis-admin/package.json`
- `rezeis-admin/package-lock.json`
- `rezeis-admin/web/package.json`
- `rezeis-admin/web/package-lock.json`

Work:

- Backend: investigate Prisma dev-tooling `@hono/node-server` moderate advisory without forced downgrade.
- Web: decide whether `face-api.js` is still needed. If not needed, remove it. If needed, isolate/upgrade knowingly.

Acceptance:

- `cd rezeis-admin && npm audit` passes: found 0 vulnerabilities.
- `cd rezeis-admin/web && npm audit` passes: found 0 vulnerabilities.

## P1 — Deploy Safety

Goal: reduce production blast radius and make deploy instructions match the real topology.

### P1.1 Remove Hardcoded DB/Redis Credentials

Status: Mostly completed 2026-06-03. Production `rezeis-admin/docker-compose.yml` no longer contains the fixed `rezeis_secret`, Redis password `rezeis`, or fixed Postgres `DATABASE_URL`; compose now requires explicit `DATABASE_PASSWORD` and `REDIS_PASSWORD` via env interpolation and validates with `docker compose -f docker-compose.yml config --quiet --no-env-resolution` when dummy values are provided. Root/admin docs now describe generated split `DATABASE_*` and `REDIS_*` values plus the existing-install migration note. Remaining blocker: repository guardrails for this session prohibit reading or editing `.env.*`, so `.env.example` still needs a follow-up update or explicit user approval.

Files:

- `rezeis-admin/docker-compose.yml`
- `rezeis-admin/.env.example`
- `README.md`

Work:

- Replace hardcoded `rezeis_secret`, `rezeis`, and fixed `DATABASE_URL` with env interpolation or Docker secrets.
- Prefer Docker Compose secrets for passwords where practical.
- Keep a migration note for existing installs.

Acceptance:

- Fresh compose requires explicit `DATABASE_PASSWORD` and `REDIS_PASSWORD` or generated values.
- `docker compose -f docker-compose.yml config --quiet --no-env-resolution` succeeds with dummy secret values.
- No hardcoded production DB/Redis passwords remain in `rezeis-admin/docker-compose.yml`.
- `.env.example` match is blocked until `.env.*` edits are explicitly allowed.

External basis:

- Docker Compose docs recommend secrets for passwords/API keys instead of environment variables when possible.

### P1.2 Split Networks By Trust Boundary

Status: Completed 2026-06-03. `rezeis-admin/docker-compose.yml` now defines an internal `rezeis-private` network. `rezeis-db` and `rezeis-redis` attach only to that private network; `rezeis` and `rezeis-worker` attach to both `rezeis-private` and the external `remnawave-network`, preserving app/proxy/Reiwa reachability while removing direct DB/Redis exposure from the shared network. Verified with `docker compose -f docker-compose.yml config --quiet --no-env-resolution` using dummy secret env values.

Files:

- `rezeis-admin/docker-compose.yml`
- `deploy/proxies/**`

Work:

- Put Postgres and Redis on a private internal network.
- Keep only app/proxy-facing services on `remnawave-network` as needed for Reiwa/edge communication.
- Verify Reiwa can still reach the required Rezeis API hostname/port.

Acceptance:

- DB/Redis are not reachable by arbitrary containers on `remnawave-network`.
- `docker compose -f docker-compose.yml config --quiet --no-env-resolution` succeeds with dummy secret values.

### P1.3 Fix Process Roles

Status: Mostly completed 2026-06-03. `rezeis-admin/docker-compose.yml` now sets `RUID_PROCESS_ROLE=api` on the API service and `RUID_PROCESS_ROLE=worker` on the worker service. Existing runtime entrypoints already default `dist/worker.js` to the worker role and package scripts expose separate API/worker commands. Verified with `docker compose -f docker-compose.yml config --quiet --no-env-resolution` using dummy secret env values. Remaining blocker: `.env.example` may still document `RUID_PROCESS_ROLE=all`, but `.env.*` files cannot be read/edited in this session without explicit approval.

Files:

- `rezeis-admin/docker-compose.yml`
- `rezeis-admin/.env.example`
- `src/common/runtime/process-role.util.ts`

Work:

- Set API service role to `api`.
- Set worker service role to `worker`.
- Avoid default `RUID_PROCESS_ROLE=all` in split compose mode.
- Add startup warning or guard if API runs as `all` while worker is configured.

Acceptance:

- Scheduler/worker jobs do not double-run in the documented compose mode.
- `.env.example` cleanup is blocked until `.env.*` edits are explicitly allowed.

### P1.4 Expand Docker Ignore And Build Hygiene

Status: Completed 2026-06-03. `rezeis-admin/.dockerignore` now excludes local env files, certs/keys, runtime data, uploads, backups, SQL/dump/tar backup artifacts, logs, coverage, package-manager caches, tmp/scratch directories, tests, and local docs from the production Docker build context.

Files:

- `rezeis-admin/.dockerignore`

Work:

- Exclude `.env`, `.env.*`, `data/`, `uploads/`, `backups/`, `*.sql`, `*.dump`, `*.tar`, `*.tar.gz`, certs, keys, logs, coverage, and local scratchpads.

Acceptance:

- Local secrets/backups are not sent as Docker build context.

### P1.5 Harden Proxy Runtime

Status: Completed 2026-06-03. The canonical root `deploy/proxies` tree now has hardened Traefik defaults: `traefik:v3.3` is pinned, the Docker socket mount is removed, the file provider remains the only provider, dashboard/debug are disabled, and a Traefik healthcheck is present. The dev-only Cloudflare quick tunnel image is pinned to `cloudflare/cloudflared:2025.8.1`. Root `deploy/proxies/README.md` is marked canonical and the duplicated `rezeis-admin/deploy/proxies` README is marked legacy/reference-only. Verified all root proxy compose files with `docker compose -f docker-compose.yml config --quiet --no-env-resolution`.

Files:

- `deploy/proxies/traefik/docker-compose.yml`
- `deploy/proxies/traefik/traefik.yml`
- duplicated proxy docs under `deploy/proxies` and `rezeis-admin/deploy/proxies`

Work:

- Remove Docker socket mount from Traefik when using file provider.
- Disable dashboard/debug by default.
- Pin proxy images away from `latest`.
- Pick one canonical proxy tree or clearly mark one as legacy.

Acceptance:

- Public-facing proxy has no unnecessary Docker socket access.
- Root proxy compose configs validate without env resolution.

### P1.6 Version And Release Metadata

Status: Completed 2026-06-03. Docker image metadata, package versions, README examples, release notes, and health response metadata now align on `0.7.3`. `rezeis-admin/Dockerfile` defaults `APP_VERSION=0.7.3` and accepts `GIT_SHA`; `.github/workflows/docker-publish.yml` passes `APP_VERSION` from `rezeis-admin/package.json` and `GIT_SHA` from `github.sha`; health responses include `version` and non-sensitive `gitSha`; README/docs examples point at the unified `ghcr.io/dizzzable/rezeis` image tags. Verified with focused health controller/service tests.

Files:

- `rezeis-admin/Dockerfile`
- `.github/workflows/docker-publish.yml`
- `README.md`
- `RELEASE_NOTES.md`
- package versions

Work:

- Pass `APP_VERSION` from tag/package version or git SHA.
- Align README badges/examples and release notes with `0.7.3` or current release.
- Expose git SHA/image digest in health output if practical.

Acceptance:

- Runtime health, image tags, README, and package version do not contradict each other.
- `node --require ts-node/register --test test/health.controller.spec.ts test/health.service.spec.ts` passes.

## P1 — Admin Security

Goal: close direct admin/control-plane risks before broad polish.

### S1 CORS Allowlist

Status: Completed 2026-06-03 for runtime/config validation. `ADMIN_CORS_ORIGINS` is now the only source for credentialed browser CORS origins; values are normalized to `scheme://host[:port]`, deduplicated, and reject `*`, non-HTTP(S), invalid URLs, embedded credentials, paths, queries, and hashes. When `NODE_ENV=production`, missing/blank `ADMIN_CORS_ORIGINS` fails validation before Nest starts, so production no longer falls back to permissive origin reflection. Outside production, missing origins keep CORS closed instead of reflecting arbitrary origins. Verified with `node --require ts-node/register --test test/env.schema.spec.ts test/http-runtime.middleware.spec.ts`, `npm run typecheck`, and focused ESLint on changed backend files. `.env.example` still was not read or edited because repo guardrails for this session prohibit reading/editing `.env.*` without explicit approval.

Files:

- `rezeis-admin/src/main.ts`
- `rezeis-admin/src/common/config/env.schema.ts`
- `rezeis-admin/.env.example`

Work:

- Replace `enableCors({ origin: true, credentials: true })` with explicit allowed origins.
- In production, fail closed when no admin public origin is configured.

Acceptance:

- Browser credentialed requests are only allowed from configured admin origins.

External basis:

- OWASP recommends explicit trusted CORS origins and not blindly reflecting arbitrary origins.

### S2 CSP Rollout

Status: Completed 2026-06-03 as a safe production rollout. Helmet CSP is no longer disabled wholesale in production: `buildHelmetOptions('production')` now emits `Content-Security-Policy-Report-Only` with explicit SPA directives and no enforcing `Content-Security-Policy` header, so operators can observe violations before enforcement. The policy uses `default-src 'self'`, `script-src 'self'`, `script-src-attr 'none'`, `object-src 'none'`, `frame-ancestors 'none'`, explicit `style-src 'self' 'unsafe-inline'` for current Tailwind/UI inline style compatibility, `connect-src 'self' https: wss: ws:` for same-origin API/realtime plus deployed TLS endpoints, and bounded image/media/worker allowances for admin uploads, external configured logos, QR images, and blob workers. Non-production keeps CSP disabled to avoid breaking Vite/HMR and existing tests. Verified with `node --require ts-node/register --test test/http-runtime.middleware.spec.ts`, `npm run typecheck`, and focused ESLint on changed backend files.

Files:

- `rezeis-admin/src/main.ts`
- `rezeis-admin/web` build config if needed

Work:

- Do not flip CSP blindly.
- Start with Helmet CSP `reportOnly` or a narrow policy validated against the production bundle.
- Keep `script-src`/`style-src` decisions explicit and documented.

Acceptance:

- CSP exists in production without breaking the admin SPA.
- If temporary unsafe directives are required, they are documented with a removal path.

External basis:

- Helmet docs provide default CSP and report-only rollout options.

### S3 Swagger Exposure

Status: Completed 2026-06-03. `shouldEnableApiDocs` now fails closed whenever `NODE_ENV=production`, so `/api/docs` is not mounted in production even if `API_DOCS_ENABLED=true` is accidentally set. Outside production, the existing explicit `API_DOCS_ENABLED=true` opt-in still mounts Swagger for local/staging diagnostics. Verified with `node --require ts-node/register --test test/api-docs.spec.ts test/http-runtime.middleware.spec.ts`, `npm run typecheck`, and focused ESLint on changed backend files.

Files:

- `rezeis-admin/src/main.ts`

Work:

- Disable Swagger in production or put it behind admin auth/IP allowlist.

Acceptance:

- `/api/docs` is not public in production.

### S4 Admin Token Storage And Cache Isolation

Status: Completed 2026-06-03 for short-term cache/session-boundary hardening. `startAdminClientSession` and `endAdminClientSession` now call `queryClient.clear()` and reset sensitive client state (`usePermissionStore`, legacy `useAuthStore`) on login/logout boundaries. The admin bearer token now uses one shared `authStorage` source for axios, realtime sockets, backup download fetches, and auth bootstrap; it keeps an in-memory current-tab fallback when `localStorage` writes fail. OAuth callback handling keeps the hash-fragment token flow but removes the legacy query-string token fallback. HttpOnly cookie/BFF session migration remains a longer-term follow-up, not part of this short-term S4 slice. Verified with focused auth/session tests, web typecheck, focused ESLint, and full web `npm test`.

Files:

- `rezeis-admin/web/src/features/auth/auth-provider.tsx`
- `rezeis-admin/web/src/lib/api.ts`
- `rezeis-admin/web/src/lib/admin-session.ts`
- `rezeis-admin/web/src/lib/auth-storage.ts`
- `rezeis-admin/web/src/lib/query-client.ts`
- Zustand stores with sensitive state

Work:

- On logout and login boundary, call `queryClient.clear()` and reset sensitive stores.
- Remove OAuth query-string token fallback if not strictly needed.
- Longer-term: migrate admin session from localStorage bearer token to HttpOnly cookie/BFF session.
- Short-term: add CSP, shorter token TTL, in-memory fallback when localStorage is unavailable.

Acceptance:

- Admin B cannot see Admin A cached data after logout/login in the same tab.
- Auth still works when localStorage writes fail, or failure is explicit and safe.

Verification:

- `cd rezeis-admin/web && npx vitest run src/lib/auth-storage.test.ts src/lib/admin-session.test.ts` passed: 7 tests.
- `cd rezeis-admin/web && npx tsc -p tsconfig.app.json --noEmit --incremental false` passed.
- Focused ESLint on changed web auth/session files passed.
- `cd rezeis-admin/web && npm test` passed: 11 files, 62 tests.

External basis:

- OWASP recommends not storing session identifiers/sensitive auth data in localStorage.
- TanStack Query documents `queryClient.clear()` for clearing caches.

### S5 RBAC Completion

Status: In progress 2026-06-03. First high-risk slice completed for admin API tokens. Backend `AdminApiTokensController` now runs `AdminJwtAuthGuard` plus `RbacGuard` and requires `api_tokens:view`, `api_tokens:create`, and `api_tokens:delete` per route. `api_tokens` was added to the RBAC resource catalog without granting it to default non-superadmin system roles, so superadmin picks it up through the full-catalog seed while operators must be granted access intentionally. The OAuth provider configuration slice is also complete: backend `OAuthConfigController` now requires `auth_providers:view` for listing provider configuration and `auth_providers:edit` for updates/secrets, while public OAuth login/callback endpoints and current-admin passkey self-service remain outside this global provider-administration permission. The backup/config-portability/import high-risk slice is complete: backup list/download/create/delete/restore routes require explicit `backups` grants, config section/export/import routes require `config_portability:view/export/import`, and import history/file/live import/sync/cancel/plan follow-up routes require `imports:view/import/run`. The payment gateway registry slice is complete: gateway list/detail/supported-currency reads require `payment_gateways:view`, updates/moves/default seeding require `payment_gateways:edit`, the sidebar hides the gateway settings page without `view`, the page does not fetch credential-bearing gateway settings without `view`, and write controls are hidden without `edit`. Frontend API-token management does not fetch token rows without `api_tokens:view`, hides create/revoke controls without `create`/`delete`, and hides the panel-settings API-token tab behind `api_tokens:view`. Frontend OAuth provider settings are split out of the self-service Security tab, hidden behind `auth_providers:view`, do not fetch `/admin/oauth/config` without that grant, and render read-only without `auth_providers:edit`. Frontend backup/config/import pages now avoid fetches without `view`, render read-only states without write grants, and hide matching panel tabs/nav entries. Remaining S5 work: continue route-by-route audit only where a clear admin surface gap remains; do not globalize `RbacGuard` yet.

Files:

- Backend admin controllers under `src/modules/**/controllers`
- `web/src/app/router.tsx`
- `web/src/components/layout/admin-nav-config.ts`
- `web/src/components/quick-search/quick-search-overlay.tsx`
- `web/src/features/rbac/permission-gate.tsx`

Work:

- Add explicit backend `@RequirePermission` coverage to sensitive admin endpoints before globalizing RBAC.
- Add frontend route metadata and nav/quick-search filtering.
- Gate create/edit/delete/export/bulk actions with the same permission map.

Acceptance:

- Lower-privileged admins cannot navigate to or trigger unauthorized admin screens/actions.
- Backend still enforces the final authority.

Latest S5 verification:

- `cd rezeis-admin && node --require ts-node/register --test test/admin-payment-gateways.controller.spec.ts test/payment-gateway-registry.service.spec.ts` passed: 8 tests.
- `cd rezeis-admin/web && npx vitest run src/features/payments/gateway-settings-page.test.tsx` passed: 2 tests.
- `cd rezeis-admin && npm run typecheck` passed.
- `cd rezeis-admin/web && npx tsc -p tsconfig.app.json --noEmit --incremental false` passed.
- Focused ESLint on changed gateway RBAC backend/web files passed.
- `cd rezeis-admin && node --require ts-node/register --test test/admin-backup-rbac.controller.spec.ts test/admin-config-portability-rbac.controller.spec.ts test/imports.controller.spec.ts` passed: 11 tests.
- `cd rezeis-admin && npm run test:maintained:admin-surfaces` passed: 23 tests.
- `cd rezeis-admin/web && npx vitest run src/features/backup/backup-page.test.tsx src/features/imports/imports-page.test.tsx src/features/config-portability/config-portability-page.test.tsx` passed: 6 tests.
- `cd rezeis-admin/web && npx vitest run src/features/settings/api-tokens-page.test.tsx src/features/settings/auth-providers-tab.test.tsx src/features/backup/backup-page.test.tsx src/features/imports/imports-page.test.tsx src/features/config-portability/config-portability-page.test.tsx` passed: 12 tests.
- `cd rezeis-admin && npm run typecheck` passed.
- `cd rezeis-admin/web && npx tsc -p tsconfig.app.json --noEmit --incremental false` passed.
- Focused ESLint on changed backend/web RBAC files passed.
- `cd rezeis-admin && node --require ts-node/register --test test/admin-api-tokens.controller.spec.ts` passed: 4 tests.
- `cd rezeis-admin && node --require ts-node/register --test test/admin-oauth-config.controller.spec.ts` passed: 4 tests.
- `cd rezeis-admin && npm run typecheck` passed.
- `cd rezeis-admin && npm run lint` passed.
- `cd rezeis-admin/web && npx vitest run src/features/settings/api-tokens-page.test.tsx` passed: 3 tests.
- `cd rezeis-admin/web && npx vitest run src/features/settings/auth-providers-tab.test.tsx` passed: 3 tests.
- `cd rezeis-admin/web && npx tsc -p tsconfig.app.json --noEmit --incremental false` passed.
- Focused ESLint on changed backend/web RBAC, API-token, and OAuth provider files passed.
- `cd rezeis-admin/web && npm test` passed: 13 files, 68 tests.

### S6 API Tokens Hardening

Status: Mostly completed 2026-06-03. Backend hardening is complete for the current single internal audience: new API tokens are created with explicit JWT audience `rezeis-internal-api` and a 180-day TTL; `ApiToken` persists only `tokenHash`, `audience`, prefix, creator, timestamps, and `expiresAt`; migration `20260603190000_api_token_hash_audience` backfills SHA-256 fingerprints and 180-day expiration for existing raw-token rows before dropping the raw `token` column; `InternalAdminAuthGuard` now verifies JWT type, optional legacy-compatible audience, DB audience, timing-safe fingerprint match, and DB expiration before authorizing internal API calls. `lastUsedAt` writes are throttled to one update per token per five minutes to avoid one DB write per internal request. RBAC create/list/delete gating was already completed under S5. Frontend/operator UX now shows expiration/expired state, explains create-update-client-revoke rotation, and handles clipboard failures. Remaining S6 work is limited to future per-audience scopes if concrete additional internal clients need separation.

Files:

- `src/modules/api-tokens/**`
- `src/modules/auth/guards/internal-admin-auth.guard.ts`
- `src/modules/auth/constants/api-token-auth.constants.ts`
- `src/modules/auth/utils/api-token-hash.util.ts`
- `prisma/schema.prisma`
- `prisma/migrations/20260603190000_api_token_hash_audience/migration.sql`

Work:

- Add RBAC requirement to create/list/delete API tokens. Completed under S5.
- Consider token scopes/audience for Reiwa vs monitoring vs bot listeners. First audience slice completed with `rezeis-internal-api`; more granular scopes remain open only if separate internal clients need different privileges.
- Consider shorter TTL/rotation and storing only token hash at rest. Completed for this baseline: hash-only storage, 180-day JWT/DB expiration, and operator rotation guidance.
- Ensure `lastUsedAt` updates do not create excessive DB write load. Completed with a five-minute update throttle in `InternalAdminAuthGuard`.

Acceptance:

- Not every authenticated admin can mint long-lived internal API tokens.
- A database leak no longer exposes reusable API-token bearer strings for newly-created or migrated tokens.
- Expired API tokens no longer authenticate even if their DB row remains present.
- Operators can identify token expiration and rotate by creating a replacement, updating the integration, and revoking the old token.

Latest S6 verification:

- `cd rezeis-admin && node --require ts-node/register --test test/api-tokens.service.spec.ts test/internal-admin-auth.guard.spec.ts test/admin-api-tokens.controller.spec.ts` passed: 11 tests.
- `cd rezeis-admin && npm run typecheck` passed.
- Focused backend ESLint on API-token service, guard, constants, and specs passed.
- `cd rezeis-admin/web && npx vitest run src/features/settings/api-tokens-page.test.tsx` passed: 3 tests.
- `cd rezeis-admin/web && npx tsc -p tsconfig.app.json --noEmit --incremental false` passed.
- Focused web ESLint on API-token page/API/i18n files passed.

### S7 Payment Diagnostics Sanitization

Status: In progress 2026-06-04. Shared diagnostic redaction now masks auth/proxy-auth headers, cookies/set-cookie values, URL assignments (`profileUrl`, `config_url`, checkout/redirect/callback variants), provider/gateway identifier assignments, existing URL/email/UUID/provider-ID patterns, token words, and long hex secrets. Provider checkout persistence now stores only a redacted `gatewayData.providerResponse` while keeping operational fields such as `gatewayId`, top-level `checkoutUrl`, and provider status available for the checkout flow. Antilopay provider-declared checkout errors are redacted before surfacing through the service exception path. Webhook ops routes are guarded with `RbacGuard` and explicit `payment_webhooks:view/resolve/run` permissions. Webhook event detail `includeRaw=true` records an audit event but returns the redacted payload instead of the stored unredacted payload. Public/internal webhook ingress responses no longer echo the normalized envelope or raw webhook payload while preserving inbox persistence and reconciliation queue payloads. Payment analytics top failure/error labels are now redacted before returning broadly visible `analytics:view` reports. User-facing/internal payment status payloads were audited in this slice; no raw `gatewayData.providerResponse` or diagnostic payload leak was found beyond already-normalized `failureReason` codes.

Files:

- `src/modules/payments/services/payments-checkout.service.ts`
- `src/modules/payments/services/payment-webhook-inbox.service.ts`
- `src/modules/payments/services/payment-ops-alert.service.ts`
- `src/modules/payments/services/payment-provider-execution.service.ts`
- `src/modules/payment-analytics/services/payment-analytics.service.ts`
- `src/modules/payments/services/payment-webhook-ingress.service.ts`
- `src/modules/payments/services/payment-webhook-ops.service.ts`
- `src/modules/payments/interfaces/payment-webhook-envelope.interface.ts`
- `src/modules/payments/services/payment-webhook-payload-redaction.service.ts`
- `src/modules/payments/controllers/admin-payment-webhooks.controller.ts`
- `src/modules/payments/utils/payment-provider-error.util.ts`
- related failing payment tests

Work:

- Sanitize provider URLs, raw tokens, provider IDs, profile/config links, cookies, authorization fragments before storing or returning errors.
- Keep raw diagnostics only in a protected, redacted, bounded operator log if absolutely needed.
- Sanitize `gatewayData.providerResponse` before transaction persistence while preserving explicit checkout-flow fields. Completed for the provider checkout path.
- Sanitize provider-declared checkout exception messages before returning service-level payment errors. Completed for the Antilopay non-zero response path.
- Gate admin webhook ops routes with route-level RBAC metadata. Completed for list/detail/replay.
- Stop returning unredacted stored webhook payloads from admin detail reveal requests while preserving audit logging. Completed for the current `includeRaw=true` detail path.
- Stop echoing normalized webhook envelopes/raw payloads from public/internal ingress responses. Completed for the current ingress response contract.
- Sanitize payment analytics failure/error labels built from historical `providerStatus` and webhook `last_error` values. Completed for provider and webhook analytics reports.
- Remaining S7/S5 crossover: decide whether admin-visible `gatewayId`/`providerEventId` are acceptable operational identifiers or should be masked/gated more tightly; admin transaction endpoints should be reviewed for explicit route-level RBAC before any global guard rollout.

Acceptance:

- Existing redaction-focused payment tests pass.
- User-facing/internal Reiwa payment status responses expose stable error codes, not provider raw diagnostics.
- Transaction `gatewayData.providerResponse` no longer persists raw provider response IDs, auth fragments, emails, signatures, or provider URLs.
- Admin webhook ops routes require explicit `payment_webhooks` permissions in addition to admin JWT authentication.
- Admin webhook detail reveal requests no longer return unredacted stored webhook payloads.
- Public/internal webhook ingress responses no longer expose raw webhook bodies.
- Payment analytics reports do not expose raw provider status strings or webhook errors containing URLs, tokens, emails, provider identifiers, or Redis/DB URLs.

Latest S7 verification:

- `cd rezeis-admin && node --require ts-node/register --test test/payment-analytics.service.spec.ts test/payment-provider-execution.service.spec.ts` passed: 8 tests.
- `cd rezeis-admin && npm run test:maintained:core` passed: 356 tests.
- `cd rezeis-admin && npm run typecheck` passed.
- `cd rezeis-admin && npx eslint src/modules/payment-analytics/services/payment-analytics.service.ts src/modules/payments/services/payment-provider-execution.service.ts test/payment-analytics.service.spec.ts test/payment-provider-execution.service.spec.ts` passed.
- `cd rezeis-admin && node --require ts-node/register --test test/payment-webhook-ingress.service.spec.ts test/public-payment-webhooks.controller.spec.ts test/internal-payment-webhooks.controller.spec.ts` passed: 12 tests.
- `cd rezeis-admin && npm run typecheck` passed.
- `cd rezeis-admin && npx eslint src/modules/payments/services/payment-webhook-ingress.service.ts src/modules/payments/interfaces/payment-webhook-envelope.interface.ts test/payment-webhook-ingress.service.spec.ts` passed.
- `cd rezeis-admin && node --require ts-node/register --test test/payment-webhook-ops.service.spec.ts test/payment-webhook-payload-redaction.service.spec.ts test/admin-payment-webhooks.controller.spec.ts` passed: 21 tests.
- `cd rezeis-admin && npm run typecheck` passed.
- `cd rezeis-admin && npx eslint src/modules/payments/services/payment-webhook-ops.service.ts test/payment-webhook-ops.service.spec.ts` passed.
- `cd rezeis-admin && node --require ts-node/register --test test/payment-provider-error.util.spec.ts test/payment-provider-execution.service.spec.ts test/payments-checkout.service.spec.ts test/addon-purchase.service.spec.ts test/payment-webhook-inbox.service.spec.ts test/payment-webhook-ops.service.spec.ts test/payment-webhook-payload-redaction.service.spec.ts test/payment-ops-alert-delivery.service.spec.ts test/admin-payment-webhooks.controller.spec.ts` passed: 42 tests.
- `cd rezeis-admin && npm run typecheck` passed.
- Focused backend ESLint on changed payment service/controller/spec files passed.

## P2 — Frontend Correctness And UX

### F1 Auth Readiness

Status: Completed 2026-06-04. Protected admin routes now treat the session as authenticated only after both `/admin/auth/me` and the effective permissions/mustChangePassword snapshot have resolved. Forced password-change admins stay on the locked verification screen until permissions resolve, then redirect to `/change-password` without rendering the admin shell. Permission probe failures keep the workspace locked with a retry path instead of silently falling through or spinning forever. `/change-password` is now authenticated-only through `ProtectedRoute`, but remains outside the full admin shell.

Work:

- Treat auth as ready only after `/me` and effective permissions/mustChangePassword are resolved or failed safely.
- Protect `/change-password` as authenticated-only.

Acceptance:

- Forced password-change users cannot briefly render the admin shell.
- Unauthenticated users cannot render `/change-password`.

Verification:

- `cd rezeis-admin/web && npx vitest run src/features/auth/auth-provider.test.tsx src/lib/admin-session.test.ts src/features/settings/api-tokens-page.test.tsx src/features/settings/auth-providers-tab.test.tsx src/features/backup/backup-page.test.tsx src/features/imports/imports-page.test.tsx src/features/config-portability/config-portability-page.test.tsx src/features/payments/payments-page.test.tsx src/features/payments/gateway-settings-page.test.tsx src/components/layout/admin-nav-config.test.ts` passed: 10 files, 24 tests.
- `cd rezeis-admin/web && npx tsc -p tsconfig.app.json --noEmit --incremental false` passed.
- `cd rezeis-admin/web && npx eslint src/features/auth/auth-provider.tsx src/features/auth/auth-provider.test.tsx src/features/rbac/use-permission-store.ts src/app/protected-route.tsx src/app/router.tsx src/features/auth/force-password-change-page.tsx src/features/rbac/roles-page.tsx` passed.

### F2 Query Key Factories And Realtime

Status: Completed 2026-06-04. Admin query keys for the touched F2 surfaces now live in `web/src/lib/admin-query-keys.ts`; realtime invalidation uses `getRealtimeInvalidationKeys()` instead of hand-written arrays in the socket hook; backup, broadcast, dashboard, subscriptions, payments, imports, settings, notifications, and email settings queries/mutations use the shared factories where relevant. Payment realtime events invalidate transaction list prefixes, analytics prefixes, dashboard summary, and audit; webhook events invalidate webhook list/analytics prefixes; backup/broadcast/subscription/notification/email settings events target the actual query namespaces. Realtime auth failure now calls the same hard session-clear path as HTTP 401 via `forceEndAdminSession()`. Notification template create/update/delete/manual-seed and SMTP settings save operations now emit system events so other admin tabs can receive realtime invalidation; the webhook event picker catalog includes those event types.

Work:

- Centralize query keys by feature.
- Make realtime invalidation use factories, not hand-written arrays.
- On realtime auth failure, call the same logout/session-clear path as HTTP 401.

Acceptance:

- Backup, broadcast, subscriptions, payments, dashboard, and notification invalidations hit actual query keys.

Verification:

- `cd rezeis-admin/web && npx vitest run src/lib/realtime/realtime-invalidation.test.ts src/lib/admin-session.test.ts src/features/payments/payments-page.test.tsx src/features/payments/gateway-settings-page.test.tsx src/features/backup/backup-page.test.tsx src/features/imports/imports-page.test.tsx` passed: 6 files, 15 tests. React Router future-flag warnings remain pre-existing test noise.
- `cd rezeis-admin/web && npx tsc -p tsconfig.app.json --noEmit --incremental false` passed.
- Focused web ESLint on changed query/realtime/admin-surface files passed.
- `cd rezeis-admin && node --require ts-node/register --test test/email-delivery.service.spec.ts test/notification-templates.service.spec.ts test/settings.service.spec.ts test/settings.controller.spec.ts` passed: 16 tests.
- `cd rezeis-admin && npm run typecheck` passed.
- Focused backend ESLint on changed system-events/email-delivery/notification-template/webhook-catalog files passed.

### F3 Production Devtools And Client Logging

Status: Completed 2026-06-04. React Query Devtools are now dynamically imported only when `import.meta.env.DEV` is true, so production builds do not include the devtools module or toggle. Client crash reports and local diagnostics now pass through shared redaction for query strings, bearer/basic auth, cookies, token/password/secret assignments, emails, UUIDs, JWT-like values, and long hex secrets before POSTing to `/admin/client-errors` or printing development-only console diagnostics.

Work:

- Render React Query Devtools only in development.
- Redact client error logs: tokens, emails, UUIDs, query params, authorization/cookie fragments.

Acceptance:

- Production screen sharing/devtools cannot trivially expose full admin query caches.

Verification:

- `cd rezeis-admin/web && npx vitest run src/lib/client-logger.test.ts src/features/auth/auth-provider.test.tsx` passed: 2 files, 6 tests. React Router future-flag warnings remain pre-existing test noise.
- `cd rezeis-admin/web && npx tsc -p tsconfig.app.json --noEmit --incremental false` passed.
- Focused web ESLint on changed provider/client-logger/auth/error-boundary files passed.
- `cd rezeis-admin/web && npm run build` passed, and a production `dist` grep found no `react-query-devtools` / `ReactQueryDevtools` references.

### F4 Critical Form Schemas

Status: In progress 2026-06-04. OAuth provider settings now use a Zod/react-hook-form validation boundary before submit. The UI blocks malformed backend/frontend domains, Generic OAuth2 authorization/token URLs, allowlist emails, and Telegram ID allowlists before calling `/admin/oauth/config/:type`, then submits normalized comma-separated allowlists for valid input. Plan create/edit payloads now pass through a Zod/react-hook-form submit boundary before mutation, block malformed limits, duplicate durations/currencies, unsupported currencies, invalid trial/archive/allowed-user combinations, and normalize unlimited traffic (`0`) to backend `null`. Remaining F4 surfaces include broadcast payload composition, notification JSON, and branding URLs.

Work:

- Add Zod/react-hook-form schemas for plans, broadcast, notification JSON, branding URLs. OAuth provider settings and plans are complete for this slice.

Acceptance:

- UI rejects malformed payloads before backend mutation.

Verification:

- `cd rezeis-admin/web && npx vitest run src/features/settings/auth-providers-tab.test.tsx` passed: 1 file, 5 tests. React Router future-flag warnings remain pre-existing test noise.
- `cd rezeis-admin/web && npx vitest run src/features/plans/plan-form-schema.test.ts src/features/plans/plan-form.test.tsx` passed: 2 files, 6 tests. React Router future-flag warnings remain pre-existing test noise.
- `cd rezeis-admin/web && npx tsc -p tsconfig.app.json --noEmit --incremental false` passed.
- Focused web ESLint on changed OAuth provider/plan form/i18n files passed.

### F5 Accessibility Baseline

Work:

- Add skip-to-content and `<main>` landmark.
- Replace native `window.confirm` destructive flows with accessible dialogs.
- Preserve visible focus and keyboard behavior.

Acceptance:

- Basic keyboard navigation and landmarks are present in admin shell.

## P3 — TypeScript Strictness And Larger Quality Work

Do not start this before P0/P1 are stable.

Work gradually:

- Enable narrower strict flags per directory or via separate `tsconfig.strict.json` first.
- Burn down `any` and `strictNullChecks` issues by bounded module.
- Promote high-signal React Compiler/ESLint warnings to errors only after the current 26 warnings are resolved.

Acceptance:

- Strictness increases without blocking urgent deploy/security fixes.

## Current Verification Commands

Backend:

```powershell
npm run typecheck
npm run lint
npm test
npm audit
```

Web:

```powershell
npx tsc -p tsconfig.app.json --noEmit --incremental false
npm test
npm run lint
npm run build
npm audit
```

Docker/deploy after P1 changes:

```powershell
docker compose config
docker build -t rezeis-admin-local .
```

## Definition Of Done For The Remediation Track

- Root CI runs and reflects real gates.
- Docker publish is gated by CI.
- Backend maintained tests are green.
- Web build is green.
- Audits are clean or documented with accepted risk.
- Compose has no hardcoded production secrets.
- DB/Redis are not on the broad shared network.
- Admin logout/login clears cached data and sensitive stores.
- Admin route/nav/action RBAC is consistent with backend permissions.
- CORS/CSP/Swagger are production-safe.
- Documentation matches the actual deploy topology.
