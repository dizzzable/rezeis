# Rezeis Agent Handoff

This repository contains the Rezeis admin/control-plane code. Treat it separately from `V:\REZEIS_ADMIN_RUID_USER\reiwa`.

## Product Boundary

- `rezeis/rezeis-admin` is the admin panel and source of truth for users, subscriptions, payments, settings, bot config, partner/referral logic, and internal APIs.
- `reiwa` is the user-facing runtime. It talks to `rezeis-admin` over the shared Docker network through `/api/internal/*` APIs using admin-issued API tokens.
- Do not move business truth from `rezeis-admin` into `reiwa` unless the user explicitly asks for an architecture change.

## Required Session Bootstrap

At the start of a new coding session in this repository:

1. Read `docs/progress/next-session-handoff.md`.
2. Read `docs/progress/rezeis-remediation-plan.md`.
3. Run `git status --short` from `V:\REZEIS_ADMIN_RUID_USER\rezeis`.
4. Do not touch untracked `.claude/` or `IMPROVEMENT_PLAN.md` unless the user explicitly asks.
5. Do not read `.env`, `.env.*`, SQL dumps, tar backups, or real backup artifacts.
6. Run `npm run handoff:update` after changing remediation status, or `npm run handoff:update:verify` when you intentionally want to refresh the gate snapshot by running checks.

## Continuation Trigger

If the user's first message is any of these phrases, treat it as an explicit request to continue the remediation work without asking for another plan:

- `продолжение нужно`
- `продолжай rezeis`
- `продолжай план rezeis`
- `continue rezeis remediation`
- `next rezeis slice`

When this trigger is used:

1. Read `docs/progress/next-session-handoff.md` and `docs/progress/rezeis-remediation-plan.md`.
2. Run `git status --short` from repository root.
3. Run `npm run handoff:update` from repository root to refresh the handoff timestamp without re-running slower verification gates.
4. Start with the current `Recommended First Slice` in `next-session-handoff.md` unless the user includes a more specific target in the same message.
5. Load the relevant skill before implementation: use `nestjs-core`/`nestjs-platform` for backend test triage and security/config failures, and `typescript-config` for build/typecheck behavior.
6. Make the smallest correct code/config change, run the narrowest relevant verification, then update `next-session-handoff.md` with the new observed result.

Do not use this trigger to read secrets, run destructive commands, or rewrite the rezeis/reiwa service boundary.

## Current Known Quality Gate State

Last checked: 2026-06-03.

- `rezeis-admin`: `npm run typecheck` passes.
- `rezeis-admin`: `npm run lint` passes.
- `rezeis-admin`: `npm test` passes: 513 tests.
- `rezeis-admin`: `npm run test:maintained` passes: 423 tests (336 core + 22 admin-surfaces + 65 email-linking).
- `rezeis-admin`: `npm audit` passes after overriding Prisma dev tooling `@hono/node-server` to a patched version.
- `rezeis-admin/web`: `npx tsc -p tsconfig.app.json --noEmit --incremental false` passes.
- `rezeis-admin/web`: `npm test` passes.
- `rezeis-admin/web`: `npm run lint` passes with 26 warnings.
- `rezeis-admin/web`: `npm run build` passes.
- `rezeis-admin/web`: `npm audit` passes after overriding transitive `node-fetch` under `face-api.js` to a patched version.

## Work Order

Prefer this order unless the user gives a narrower task:

1. Make gates trustworthy: root CI, web typecheck/build, backend test triage.
2. Fix deploy safety: credentials, networks, process roles, `.dockerignore`, Traefik socket, image/version metadata.
3. Fix admin security: CORS, CSP, Swagger exposure, token/cache lifecycle, RBAC, API tokens, payment diagnostics.
4. Fix frontend correctness: auth readiness, route/nav/action RBAC, query-key consistency, devtools gating, form schemas.
5. Only then start broad TypeScript strictness or polish.

## Skills To Load When Relevant

- `nestjs-platform`: NestJS config, validation, CORS, Swagger, Helmet, deployment, health checks, auth platform wiring.
- `nestjs-core`: modules, providers, guards, interceptors, filters, DI boundaries.
- `react-state`: auth provider state, logout/login cache isolation, query/store reset, render timing.
- `react-effects`: effects, realtime subscriptions, socket cleanup, service worker listeners.
- `typescript-config`: tsconfig strictness or build/typecheck behavior.
- `accessibility`: layout landmarks, skip links, dialog/focus/keyboard fixes.

## External References Already Consulted

- GitHub Actions: workflow files must be stored in repository-root `.github/workflows`.
- OWASP HTML5 Security Cheat Sheet: do not store session identifiers/sensitive auth data in localStorage; use explicit CORS allowlists.
- Docker Compose secrets docs: prefer secrets over environment variables for passwords/API keys where possible.
- Docker rootless docs: run containers/daemon without root where feasible.
- Helmet docs: use/configure CSP instead of disabling it wholesale; report-only is useful for rollout.
- TanStack Query `QueryClient`: `queryClient.clear()` clears connected caches and is the right primitive for logout/session boundary resets.

## Guardrails

- Never run destructive git commands.
- Never hardcode real secrets or read local secret files.
- Prefer small, verifiable slices.
- After each slice, run the narrowest relevant gate and update `docs/progress/next-session-handoff.md` if status changes.
- Use `npm run handoff:update` for a timestamp/status refresh without running gates.
- Use `npm run handoff:update:verify` only when it is acceptable to run all configured gates; full verification is slow and audits can still be red.
