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
- Payment webhook ingress, payment provider signature verification, webhook inbox/deduplication, and payment execution policy.
- User activity truth and read models, including notification unread state and payment-status notification events.
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

The first concrete `ruid -> rezeis-admin` contract is the narrow `internal/user`, `internal/catalog`, `internal/subscriptions`, and `internal/settings` slice:

- `GET /api/internal/user/session` for session bootstrap and refreshed session reads.
- `POST /api/internal/user/web-account/sign-in` for admin-owned linked web-account credential verification.
- `POST /api/internal/user/web-account/password-recovery` for anti-enumeration-safe linked web-account recovery initiation and reset-link email delivery.
- `POST /api/internal/user/web-account/password-recovery/telegram` for anti-enumeration-safe linked web-account recovery continuation through an already-started Telegram bot chat.
- `POST /api/internal/user/web-account/password-reset-by-link` for token-based linked web-account password reset completion.
- `POST /api/internal/user/web-account/password-reset-by-telegram-code` for admin-owned linked web-account password reset completion from the Telegram-issued code flow.
- `PATCH /api/internal/user/session/rules-acceptance` for current-session rules acceptance.
- `PATCH /api/internal/user/session/web-account-link-prompt-snooze` for current-session linked-account reminder snooze.
- `PATCH /api/internal/user/session/web-account-password` for current-session linked-account password handoff.
- `PATCH /api/internal/user/session/web-account-email-verification-challenge` for current-session linked email-verification challenge issuance.
- `PATCH /api/internal/user/session/web-account-email-verification-completion` for current-session linked email-verification completion.
- `GET /api/internal/user/activity/transactions` for admin-owned user transaction history reads.
- `GET /api/internal/user/activity/notifications` for admin-owned user notification reads.
- `GET /api/internal/user/activity/notifications/unread-count` for admin-owned unread-count reads.
- `POST /api/internal/user/activity/notifications/:notificationId/read` for notification acknowledgement.
- `POST /api/internal/user/activity/notifications/read-all` for bulk notification acknowledgement.
- `GET /api/internal/catalog/plans` for public/session-aware catalog reads.
- `GET /api/internal/user/subscription` for current subscription status. The shipped payload is still a passive snapshot only: `id`, `status`, `isTrial`, `plan`, `trafficLimit`, `deviceLimit`, `configUrl`, `startedAt`, `expiresAt`, `createdAt`, `updatedAt`.
- `POST /api/internal/subscriptions/action-policy` for session-scoped purchase-action eligibility reads.
- `POST /api/internal/subscriptions/quote` for session-scoped quote preview reads.
- `GET /api/internal/settings/platform-policy` for the user-safe platform policy projection.
- `POST /api/internal/promocodes/activate` for admin-owned promo activation execution.
- `GET /api/internal/promocodes/eligible-subscriptions` for promo branching guidance when a subscription selection is required.
- `GET /api/internal/promocodes/activations` for user-facing promo activation history reads.

Public `ruid` auth mirrors already shipped for this slice:

- `POST /api/v1/auth/web-account/sign-in`
- `POST /api/v1/auth/web-account/password-recovery`
- `POST /api/v1/auth/web-account/password-recovery/telegram`
- `POST /api/v1/auth/web-account/password-reset-by-link`
- `POST /api/v1/auth/web-account/password-reset-by-telegram-code`

Contract rules for this slice:

- Access is guarded by the existing internal API key mechanism.
- Session and subscription reads resolve exactly one identifier: `userId`, `email`, or `telegramId`.
- Standalone linked web-account sign-in resolves only the submitted linked login and password; credential truth and readiness checks remain in `rezeis-admin`.
- Standalone linked web-account password recovery, Telegram-assisted recovery continuation, reset-by-link completion, and reset-by-telegram-code completion remain admin-owned in `rezeis-admin`; `ruid` only forwards the public request, never accepts a client-supplied `userId`, and must preserve anti-enumeration-safe responses.
- Telegram phases 2 and 3 reuse the same admin-owned password-reset truth as the email flow and are allowed only for linked users whose bot chat already exists because they already started the bot.
- Current-session writes, activity reads, and session-scoped quote reads resolve only the current `userId` that `ruid` already authenticated from the cookie-backed session.
- `rezeis-admin` stays responsible for subscription, entitlement, rules-policy, platform-policy, linked-account truth, and user activity truth/read models.
- `rezeis-admin` also owns promocode validation, activation records, activation metrics, reward execution truth, notification event creation, and notification unread/read state.
- `ruid` only validates context, forwards the authenticated lookup or write, and shapes public responses, including mirroring `/api/v1/activity/*`.
- `ruid/web` may expose the Telegram continuation only as a secondary `/forgot-password` entrypoint with clear linked-account and started-bot-chat preconditions, and may expose `/reset-password-telegram` only as the minimal completion page for users who already received a Telegram code.

This boundary exists to validate the thin public-edge pattern before broader payment, entitlement, or billing mutations are exposed through `ruid`.

## Subscription Devices Phase 1 Boundary (next slice, not shipped)

- Recovery work is treated as closed for planning purposes, so the next bounded donor slice returns to subscription behavior.
- Current starting seam:
  - `rezeis-admin` stays the source of truth and already exposes `GET /api/internal/user/subscription` through `InternalUserService.getSubscription()`.
  - `ruid` already mirrors that at `GET /api/v1/subscription` through `SubscriptionService`, always sourcing `userId` from the authenticated cookie session.
  - `ruid/web` already treats subscription as a read-only surface and reads it through `useSubscriptionQuery()` with shared query key `['subscription']`.
- Phase 1 scope:
  - current subscription device list
  - revoke or remove one recorded device
  - device count and device limit visibility
  - blocked or max-devices messaging
- Explicit exclusions:
  - no assignment changes
  - no regenerated subscription or config links
  - no broad subscription lifecycle rewrite
  - no quote or payment coupling
  - no speculative Remnawave or `@remnawave/backend-contract` usage in `ruid` or `ruid/web`
- Ownership rules:
  - `rezeis-admin` owns recorded-device truth, device-limit evaluation, revoke eligibility, and all Remnawave orchestration.
  - `ruid` may only mirror narrow session-bound device reads or writes and shape public responses.
  - `ruid/web` may present device state and revoke actions, but it must not talk to Remnawave directly.
  - `@remnawave/backend-contract` stays a typed schema and route-metadata dependency inside `rezeis-admin`; server-side HTTP orchestration still runs through the admin facade, not through the contract package.

## Payment Boundary

- `rezeis-admin` owns payment gateway configuration, payment execution, payment webhook ingress, replay handling, inbox/dedup state, reconciliation, and subscription mutation after completed payment.
- `ruid` may expose user-facing checkout start/status routes, but it remains a thin orchestration edge and must not own provider execution or payment state truth.

## User Activity Boundary

- `rezeis-admin` owns user activity truth and read models, unread/read notification state, and the payment completed/failed notification events written by `PaymentReconciliationService` through `UserNotificationEventsService`.
- `ruid` mirrors `/api/v1/activity/*` and may let signed-in users review transaction history or acknowledge notifications, but it must not become the source of truth for activity or notification state.

## Referral Boundary (planned, not shipped)

- `rezeis-admin` must own referral graph truth, invite issuance, qualification after purchase, referral reward issuance, and any future referral-exchange workflow such as gift-promocode creation.
- `ruid` may later expose referral dashboard reads, invite links, QR presentation, and user-triggered exchange entrypoints, but it must not own referral balance truth or exchange settlement.
- Referral points and partner balance are separate ledgers and must not be merged under one storage or one settlement rule.

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
