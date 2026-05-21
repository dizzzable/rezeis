# AltShop Subscription Devices Phase 1

## Purpose

This note records the next bounded AltShop donor slice for subscription device and
HWID behavior.

It captures why this slice is next, the exact seams already present in the repo,
the strict Phase 1 scope, and the ownership rules that keep `rezeis-admin` as the
source of truth.

It does not claim that device or HWID management is already implemented.

## Why This Is Next

- The recovery seam is treated as closed for planning purposes.
- The current repo already has a narrow, live subscription read seam that can be
  extended without reopening quote, payment, or broader lifecycle work.
- AltShop comparison shows that device visibility and device revoke behavior are a
  smaller next slice than a full subscription lifecycle rewrite.

## Current Starting Seam

### `rezeis-admin`

- `rezeis-admin` remains the source of truth.
- `InternalUserService.getSubscription()` resolves the current subscription through
  the existing internal-user seam.
- The live internal route is `GET /api/internal/user/subscription`.
- The current payload is passive snapshot only:
  - `id`
  - `status`
  - `isTrial`
  - `plan`
  - `trafficLimit`
  - `deviceLimit`
  - `configUrl`
  - `startedAt`
  - `expiresAt`
  - `createdAt`
  - `updatedAt`

Files:

- `rezeis-admin/src/modules/internal-user/services/internal-user.service.ts`
- `rezeis-admin/src/modules/internal-user/controllers/internal-user.controller.ts`

### `ruid`

- `ruid` mirrors the current subscription read at `GET /api/v1/subscription`.
- The mirror runs through `SubscriptionService`.
- The route is session-bound. `userId` comes from the authenticated cookie-backed
  session, not from client payload or query input.

Files:

- `ruid/app/api/endpoints/subscription.py`
- `ruid/app/services/subscription_service.py`
- `ruid/app/schemas/subscription.py`

### `ruid/web`

- The current subscription page is read-only.
- `useSubscriptionQuery()` is the existing browser seam.
- The shared React Query key is `['subscription']`.
- The current UI already shows status, plan, traffic limit, device limit,
  config URL visibility, and lifecycle timestamps from the passive snapshot.

Files:

- `ruid/web/src/features/subscription/use-subscription-query.ts`
- `ruid/web/src/features/subscription/subscription-api.ts`
- `ruid/web/src/features/subscription/subscription-page.tsx`

### Remnawave Integration Note

- `rezeis-admin` currently uses `@remnawave/backend-contract` for typed command
  schemas and route metadata.
- Server-side HTTP orchestration still runs through the NestJS admin facade,
  specifically `RemnawaveApiService` with `HttpService`.
- Do not describe `@remnawave/backend-contract` as an HTTP client.
- Do not move Remnawave contract usage into `ruid` or `ruid/web`.

File:

- `rezeis-admin/src/modules/remnawave/services/remnawave-api.service.ts`

## Strict Phase 1 Scope

Phase 1 is limited to:

- device list for the current subscription
- revoke or remove a recorded device
- device count and device limit visibility
- blocked or max-devices messaging

## Explicit Exclusions

Phase 1 does not include:

- assignment changes
- regenerated subscription or config links
- broad subscription lifecycle rewrite
- quote or payment coupling
- speculative Remnawave or browser-side contract usage

## Ownership Rules

- `rezeis-admin` owns subscription truth, recorded-device truth, device-limit
  evaluation, revoke eligibility, and Remnawave orchestration.
- `ruid` may only mirror narrow session-bound reads and writes for the current
  authenticated user and shape public responses.
- `ruid/web` may present device state, revoke actions, and blocked messaging, but
  it must not become a second source of truth.
- Device or HWID Phase 1 should extend the existing subscription seam, not create
  a parallel billing, quote, or assignment workflow.

## Guardrails For The Next Implementation Session

- Start from the current subscription seam, do not bypass it.
- Keep the new slice scoped to the current subscription only.
- If new internal or public routes are needed, keep them narrow and
  session-bound.
- Treat broader subscription lifecycle work as a later slice with its own design
  decision.
