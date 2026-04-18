# Next Milestone

## Milestone

Add standalone linked web-account sign-in through `ruid`, reusing the already shipped password-handoff and email-verification groundwork without moving credential truth out of `rezeis-admin`.

## Why This Is Next

- The linked-account readiness flow is already live inside an authenticated session: password handoff is implemented, challenge issuance is implemented, and verification completion is implemented.
  Files: `rezeis-admin/src/modules/internal-user/controllers/internal-user.controller.ts`, `rezeis-admin/src/modules/internal-user/services/internal-user.service.ts`, `ruid/app/api/endpoints/session.py`, `ruid/web/src/features/web-account/web-account-page.tsx`
- The public edge still has only one auth entry path: `POST /api/v1/auth/telegram/bootstrap`. The frontend auth layer still only knows how to bootstrap Telegram and then read the cookie-backed session, and the unauthenticated fallback still tells users to reopen the Mini App.
  Files: `ruid/app/api/endpoints/auth.py`, `ruid/web/src/features/auth/auth-api.ts`, `ruid/web/src/features/auth/auth-provider.tsx`, `ruid/web/src/features/auth/auth-required-state.tsx`, `ruid/web/src/features/auth/auth-provider.test.tsx`
- The browser router still exposes only `/`, `/plans`, `/subscription`, and `/web-account`, so a prepared linked account still has no dedicated web sign-in route.
  Files: `ruid/web/src/app/router.tsx`, `ruid/web/src/app/router.test.tsx`
- The persistence model already contains the linked-account ingredients needed for a narrow standalone sign-in slice. `WebAccount` stores verified email state, password hash, password-change flags, token version, and credential bootstrap timestamps.
  Files: `rezeis-admin/prisma/schema.prisma`
- This stays inside the existing boundary. `rezeis-admin` should verify linked-account credentials and remain the source of truth, while `ruid` should keep owning the public cookie session and browser-facing auth orchestration.
  Files: `docs/architecture/service-boundaries.md`, `ruid/SPEC.md`, `ruid/app/services/session_store.py`

## Concrete Tasks

1. Add an admin-owned internal linked web-account sign-in contract.
Files:
- `rezeis-admin/src/modules/auth/`
- `rezeis-admin/src/modules/internal-user/`
- `rezeis-admin/prisma/schema.prisma`
- `rezeis-admin/test/`
Behavior to verify:
- resolve the linked `WebAccount` by normalized email
- reject missing account, unverified email, and missing password with explicit domain failures
- verify the stored password hash without moving credential ownership into `ruid`
- return the same canonical user session payload that `ruid` already consumes after Telegram bootstrap and session writes

2. Mirror standalone sign-in through the `ruid` backend while keeping cookie-session ownership there.
Files:
- `ruid/app/api/endpoints/auth.py`
- `ruid/app/api/router.py`
- `ruid/app/services/internal_admin_client.py`
- `ruid/app/services/session_service.py`
- `ruid/app/schemas/`
- `ruid/tests/test_auth_endpoints.py`
- `ruid/tests/test_internal_admin_client.py`
Behavior to verify:
- accept a public email-plus-password payload on a new non-Telegram auth route
- write the same opaque Redis-backed `ruid_session` cookie used by Telegram bootstrap
- map invalid-credential and unverified-email states to stable `400` or `401` responses without leaking admin internals
- keep Telegram bootstrap, replay protection, and stale-session invalidation behavior unchanged

3. Extend `ruid/web` with a dedicated standalone sign-in entry route.
Files:
- `ruid/web/src/app/router.tsx`
- `ruid/web/src/features/auth/auth-api.ts`
- `ruid/web/src/features/auth/auth-provider.tsx`
- `ruid/web/src/features/auth/auth-required-state.tsx`
- `ruid/web/src/features/auth/`
- `ruid/web/src/features/web-account/web-account-page.tsx`
- `ruid/web/src/app/router.test.tsx`
- `ruid/web/src/features/auth/*.test.tsx`
Behavior to verify:
- unauthenticated users can reach a dedicated sign-in route instead of only seeing Telegram reopen guidance
- successful web sign-in reuses the existing authenticated shell and session query flow
- the linked-account follow-up page can guide users from password setup and verification into the standalone sign-in path
- unauthorized failures still fall back to the same auth-required shell behavior elsewhere in the app

4. Refresh the canonical boundary docs after the standalone sign-in slice lands so they cover both the already-shipped verification-completion write and the new auth path.
Files:
- `docs/architecture/service-boundaries.md`
- `ruid/SPEC.md`
- `docs/progress/current-status.md`
- `docs/progress/next-milestone.md`
- `docs/progress/decision-log.md`
Behavior to verify:
- the ownership docs stop describing the pre-completion contract
- the progress docs stop treating Telegram-only auth as the lasting public entry shape
- the refreshed docs preserve the boundary that `rezeis-admin` owns truth and `ruid` remains the thin public edge

## Open Risks To Carry Into The Milestone

- Standalone sign-in must not bypass the existing cookie-session, stale-session invalidation, or browser-origin rules already used by Telegram bootstrap. Replay protection should stay specific to Telegram `initData` reuse rather than being copied blindly onto password sign-in.
- The slice should reuse the shipped linked-account password and email-verification data rather than inventing a second account model.
- Credential verification must stay admin-owned. `ruid` should not become the source of truth for password or verification policy.
- This milestone should not expand into billing writes, subscription mutation, entitlement changes, or a broader identity redesign.
