# Service Boundaries

## Product Structure

The repository contains two logical application surfaces:

- `rezeis-admin`: the control plane and source of truth for business state.
- `ruid`: the public access surface for end users, including Telegram and Mini App entrypoints.

This split is logical first and deployment second. Both services can run on one VPS or on separate VPS hosts without changing ownership of responsibilities.

## `rezeis-admin`

`rezeis-admin` owns authoritative business logic and state transitions.

- Customer, subscription, billing, entitlement, and operator-managed configuration state.
- Admin APIs, admin web, backoffice operations, support actions, and internal automation.
- Remnawave integration policy: credentials, sync rules, webhook validation rules, provisioning decisions, and lifecycle control.
- Background jobs that mutate authoritative state or execute control-plane workflows.

When a rule answers "what is true" for the business, it belongs here.

## `ruid`

`ruid` owns the user-facing edge and should stay thin.

- Public user access flows.
- Telegram bot and Mini App entrypoints.
- User-facing API or BFF behavior tailored for app clients.
- Presentation shaping, request orchestration, session/user-context handling, and delivery of already-defined business outcomes.

`ruid` may cache, aggregate, or adapt admin-owned state for user experience, but it must not become the source of truth for that state.

## First Shared Contract

The first concrete `ruid -> rezeis-admin` contract is the narrow `internal/user` and `internal/settings` slice:

- `GET /api/internal/user/session` for session bootstrap and refreshed session reads.
- `PATCH /api/internal/user/session/rules-acceptance` for current-session rules acceptance.
- `PATCH /api/internal/user/session/web-account-link-prompt-snooze` for current-session linked-account reminder snooze.
- `PATCH /api/internal/user/session/web-account-password` for current-session linked-account password handoff.
- `PATCH /api/internal/user/session/web-account-email-verification-challenge` for current-session linked email-verification challenge issuance.
- `GET /api/internal/user/plans` for active plans listing.
- `GET /api/internal/user/subscription` for current subscription status.
- `GET /api/internal/settings/platform-policy` for the user-safe platform policy projection.

Contract rules for this slice:

- Access is guarded by the existing internal API key mechanism.
- Session and subscription reads resolve exactly one identifier: `userId`, `email`, or `telegramId`.
- Current-session writes resolve only the current `userId` that `ruid` already authenticated from the cookie-backed session.
- `rezeis-admin` stays responsible for subscription, entitlement, rules-policy, platform-policy, and linked-account truth.
- `ruid` only validates context, forwards the authenticated lookup or write, and shapes public responses.

This boundary exists to validate the thin public-edge pattern before broader payment, entitlement, or billing mutations are exposed through `ruid`.

## Must Not Be Duplicated

The following logic must not be reimplemented independently in both services:

- Billing and subscription state machines.
- Entitlement and access truth.
- Operator/admin workflows and manual override rules.
- Remnawave integration policy, credential ownership, and provisioning decisions.
- Domain rules that decide account lifecycle or commercial status.

If `ruid` needs one of these decisions, it should consume it from `rezeis-admin` through an explicit internal API, event, or replicated read model.

## Deployment Relation

Deployment mode does not redefine boundaries.

- Single VPS: `rezeis-admin` and `ruid` may be deployed together for operational simplicity, but they keep the same logical ownership.
- Split VPS: admin-side and user-side may be deployed separately for isolation, traffic shaping, or security posture, but `rezeis-admin` still owns business truth and `ruid` still remains a thin public edge.

Infrastructure can move. Service ownership must not.
