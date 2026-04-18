# Rezeis Admin Contour

`rezeis-admin` is the system of record for Rezeis business state and control-plane decisions.

## Owns

- Business truth for customers, subscriptions, billing state, payment-provider configuration, and operator-managed settings.
- Admin-only workflows, internal operations, support tooling, manual overrides, and automation that changes product state.
- Remnawave integration policy: credentials, mapping rules, lifecycle orchestration, webhook trust rules, and outbound sync decisions.
- Persistence and background work that define authoritative outcomes for account provisioning, access changes, and commercial state.

## Exposes

- Admin UI and admin API for operators and internal automation.
- Internal interfaces that other services may consume as readers or controlled executors.
- Events, webhooks, or internal endpoints that publish already-decided state to user-facing surfaces.

## Does Not Become

- The public Telegram or Mini App entry surface.
- A user-facing BFF for anonymous or end-user traffic.
- A place to duplicate thin presentation logic that belongs in `ruid`.

## Boundary Rule

If a decision changes business truth, entitlement, billing/subscription state, or Remnawave-side policy, that decision belongs in `rezeis-admin`. Other services may request or reflect that decision, but they must not redefine it.
