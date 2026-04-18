## RUID ownership

`ruid` is the public user-access layer for the Rezeis platform.

It owns:
- public-facing API and BFF behavior
- Telegram and bot edge integration
- Mini App backend endpoints and orchestration
- request validation, response shaping, access control, and integration flows
- worker processes that support those edge flows

It does not own:
- primary business truth
- core business entities and their lifecycle rules
- the main business database schema
- migrations or model scaffolding for business-domain persistence without a proven technical need

`rezeis-admin` remains the owner of business truth and business data. `ruid` should stay thin and focused on exposing controlled user-facing access to that functionality.

## First implemented contract

`ruid` currently consumes the first shared internal contract from `rezeis-admin` at:

- `GET /api/internal/user/session`
- `GET /api/internal/user/plans`
- `GET /api/internal/user/subscription`
- `GET /api/internal/settings/platform-policy`

This slice stays intentionally narrow.

- `ruid/web` uses a Telegram-first bootstrap model: the Mini App passes Telegram `initData`, `ruid` exchanges it through `POST /api/v1/auth/telegram/bootstrap`, and subsequent authenticated reads use the opaque cookie-backed session.
- Public plan discovery remains available without authentication, while session and subscription reads resolve identity from the authenticated cookie session instead of URL query parameters.
- The current Telegram-first slice includes dashboard account-readiness rendering from the existing `webAccount` fields returned in the session payload.
- The current Telegram-first slice includes dashboard platform-policy rendering from the admin-owned settings payload, including the real `AccessMode` enum value `INVITED`.
- The current Telegram-first slice includes frontend-only subscription diagnostics rendering from the existing subscription payload.
- The current user-facing write surface now includes four authenticated session writes:
  - `PATCH /api/v1/session/rules-acceptance`
  - `PATCH /api/v1/session/web-account-link-prompt-snooze`
  - `PATCH /api/v1/session/web-account-password`
  - `PATCH /api/v1/session/web-account-email-verification-challenge`
- The user shell consumes the returned session payload as the authoritative refreshed session after rules acceptance, reminder snooze, and password handoff. Email-verification challenge issuance returns a narrow challenge payload instead.
- The internal contract is protected by the shared internal API key mechanism.
- `ruid` exposes the user-facing mirror endpoints at `/api/v1/session`, `/api/v1/plans`, `/api/v1/platform-policy`, and `/api/v1/subscription`.
- The dedicated `/plans` and `/subscription` routes remain the primary read surfaces, while the dashboard may also render compact summaries and diagnostics from those same read models. Broader business mutations, entitlement changes, and billing state transitions remain in `rezeis-admin` until the public-edge pattern is proven.
