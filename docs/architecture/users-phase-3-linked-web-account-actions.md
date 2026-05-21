# Users Phase 3 - Linked Web-Account Operator Actions

## Purpose

This note records the exact Phase 3 boundary from the original `Users / search / support actions` transfer plan and maps it to the live `rezeis-admin` implementation.

It exists to prevent context loss.

It captures:

- what Phase 3 is
- what is in scope and out of scope
- how AltShop donor behavior compares to the live `rezeis-admin` slice
- which files currently own the backend, web, and verification seams
- why this phase is treated as already implemented rather than reopened

This note does not claim that the full donor `Users` module transfer is complete.

## Exact Phase 3 Intent

Phase 3 is the first bounded linked web-account operator-actions slice inside `/users/search`.

Its purpose is to let operators perform only the lowest-blast-radius support actions against a linked web account while keeping the users cockpit read-safe by default.

## Strict Phase 3 Scope

Phase 3 is limited to exactly these three actions:

- accept rules
- snooze web-account link prompt
- issue web-account email verification challenge

These actions live inside the existing `rezeis-admin` `/users/search` cockpit and must run through admin wrapper routes over the existing internal-user write seams.

## Explicit Exclusions

Phase 3 does not include:

- password set or password reset actions
- MFA or recovery-channel management
- raw verification code display
- token display
- impersonation or takeover flows
- direct web-account login or session takeover
- broader recovery workflows from the donor module

If a donor behavior would expose secrets, recovery artifacts, or operator-driven account takeover, it is out of scope for this phase.

## Acceptance Criteria

Phase 3 is complete only if all of the following are true.

### Backend acceptance criteria

- `rezeis-admin` exposes admin wrapper routes for all three bounded actions.
- The admin routes accept only one non-referral identifier: `userId`, `telegramId`, `email`, or `login`.
- `referralCode` is rejected on the action routes at validation time.
- Each action resolves the canonical user and delegates to the existing internal-user seam.
- The email-verification action returns bounded challenge metadata without exposing the sensitive challenge payload.

### Web acceptance criteria

- `/users/search` exposes only the three bounded actions above.
- The web client calls `/admin/users/session/*` wrapper routes, not `/internal/user/*` routes.
- The email-verification action is sent through query params, aligned with the backend contract.
- The UI refreshes the support snapshot after action completion.
- The UI does not expose password, MFA, recovery-code, token, or impersonation actions.

### Safety acceptance criteria

- The users cockpit remains read-only by default.
- Support actions stay bounded to the three approved mutations.
- Sensitive verification data stays hidden after challenge issuance.
- Search-only identifiers such as `referralCode` do not bleed into bounded mutation routes.

## Donor Comparison

AltShop's wider users/support surface goes further than this phase.

The donor includes richer account-recovery and operator intervention patterns, but those capabilities increase blast radius and can drift into secret exposure or takeover behavior if transferred naively into a web admin panel.

For Phase 3, the donor comparison supports a narrower conclusion:

- the safe low-risk actions are worth transferring
- the higher-risk recovery and takeover-style actions are intentionally excluded

So Phase 3 is not "copy donor support flows".
It is "transfer only the lowest-risk linked web-account actions into the existing `rezeis-admin` users cockpit".

## Live Ownership In `rezeis-admin`

### Backend owners

- `rezeis-admin/src/modules/users/controllers/admin-users.controller.ts`
- `rezeis-admin/src/modules/users/services/admin-users.service.ts`
- `rezeis-admin/src/modules/users/dto/admin-user-identifier-query.dto.ts`
- `rezeis-admin/src/modules/internal-user/controllers/internal-user.controller.ts`
- `rezeis-admin/src/modules/internal-user/services/internal-user.service.ts`

The admin users seam owns the bounded wrapper contract.
The internal-user seam owns the underlying business logic.

### Web owners

- `rezeis-admin/web/src/features/users/user-search-page.tsx`
- `rezeis-admin/web/src/features/users/users-api.ts`
- `rezeis-admin/web/src/i18n/en.ts`
- `rezeis-admin/web/src/i18n/ru.ts`

### Verification owners

- `rezeis-admin/test/admin-users.controller.spec.ts`
- `rezeis-admin/test/admin-users.service.spec.ts`
- `rezeis-admin/test/admin-users.http.spec.ts`
- `rezeis-admin/web/src/features/users/users-api.test.ts`
- `rezeis-admin/web/src/features/users/users-route-page.smoke.test.tsx`

## Evidence That Phase 3 Is Already Implemented

The live code already satisfies the Phase 3 boundary.

### Backend evidence

- `AdminUsersService.acceptRules()` resolves the canonical user and delegates to `internalUserService.acceptRules()`.
- `AdminUsersService.snoozeWebAccountLinkPrompt()` resolves the canonical user and delegates to `internalUserService.snoozeWebAccountLinkPrompt()`.
- `AdminUsersService.issueWebAccountEmailVerificationChallenge()` resolves the canonical user and delegates to `internalUserService.issueWebAccountEmailVerificationChallenge()`.
- `AdminUserIdentifierQueryDto` accepts exactly one bounded identifier and does not include `referralCode`.
- HTTP tests prove that `referralCode` is rejected on all three action routes.

### Web evidence

- `users-api.ts` routes the three actions through `/admin/users/session/rules-acceptance`, `/admin/users/session/web-account-link-prompt-snooze`, and `/admin/users/session/web-account-email-verification-challenge`.
- `users-api.test.ts` proves those calls use admin wrapper routes and query params.
- `user-search-page.tsx` exposes exactly the three approved actions in the linked web-account actions cluster.
- `users-route-page.smoke.test.tsx` proves the visible action set and verifies the bounded behavior, including hidden sensitive challenge data wording after challenge issuance.

## Binary Closure Decision

Phase 3 should be treated as closed.

The correct next move is not to reopen this slice with new code.
The correct next move is to keep this note as the permanent Phase 3 reference and plan the next users-module phase against the broader donor gap that still remains after this bounded slice.

## What This Note Does Not Claim

This note does not claim that:

- linked identity search is complete beyond the already shipped phases
- richer support diagnostics are complete
- broader referral or subscription support tooling is complete
- the full AltShop users/support donor module has been transferred

It only records that the original low-blast-radius Phase 3 linked web-account actions slice is already implemented and verified in `rezeis-admin`.
