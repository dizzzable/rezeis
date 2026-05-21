# Next Milestone

## Milestone

AltShop subscription devices / HWID Phase 1, built on the existing admin-owned current-subscription seam.

## Why This Is Next

- Recovery work is treated as closed for planning purposes, so the old hardening milestone is stale.
- The current repo already has a narrow, live subscription seam: `rezeis-admin` owns the passive snapshot at `GET /api/internal/user/subscription`, `ruid` mirrors it at `GET /api/v1/subscription` through `SubscriptionService`, and `ruid/web` consumes it through `useSubscriptionQuery()` with the shared query key `['subscription']`.
- That makes device or HWID Phase 1 the smallest safe AltShop donor slice that advances subscription behavior without reopening quotes, payments, or the full lifecycle state machine.

## Concrete Tasks

1. Extend the admin-owned current-subscription seam for device visibility.
- Add admin-owned reads for the current subscription's recorded devices plus device count or limit state, starting from the same truth that powers `GET /api/internal/user/subscription`.
- Keep `rezeis-admin` as the only place that decides recorded-device truth, device-limit evaluation, and blocked or max-devices state.

2. Add narrow admin-owned revoke or remove execution.
- Support revoking or removing one recorded device for the current subscription.
- Keep assignment changes, regenerated subscription or config links, and broader lifecycle mutations out of this slice.

3. Mirror the slice through `ruid` as a session-only public edge.
- Reuse the authenticated cookie session to resolve `userId`.
- Do not accept client-supplied identity for device actions.
- Keep `ruid` focused on forwarding and shaping admin-owned results.

4. Update `ruid/web` subscription UX without widening ownership.
- Build device list visibility, device count or limit visibility, revoke action wiring, and blocked or max-devices messaging on the existing subscription surface.
- Keep `ruid/web` away from direct Remnawave access and away from browser-side contract usage.

## Open Risks To Carry Forward

- The current subscription seam is passive snapshot only, so Phase 1 must not turn into a broad lifecycle rewrite.
- `@remnawave/backend-contract` remains a typed schema and route-metadata dependency inside `rezeis-admin`; server-side HTTP orchestration must stay in the admin facade.
- Quote or payment behavior, assignment changes, and config-link regeneration stay out of scope until a later, separately approved slice.
