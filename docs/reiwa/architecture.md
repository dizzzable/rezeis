# Reiwa architecture audit and implementation plan

## Decision

`ruid` is removed from the Rezeis target architecture. The new user-facing runtime is `reiwa`.

Reiwa is a TypeScript/Node service family for the public user side. It must not inherit the legacy Python `ruid` architecture.

## What was studied

### AltShop donor

AltShop remains the donor for Rezeis business logic and expected commercial/user behavior:

- access modes and rules acceptance;
- registration and login flows;
- plans and subscription purchase/renew/upgrade/trial flows;
- promocode activation and history;
- referrals and partner-like economics;
- support/user messaging;
- payment/provider flows;
- user account and notification behavior.

### `backend-main` / Remnawave Panel donor

`backend-main` remains an engineering-pattern donor, not a Rezeis domain donor:

- separated runtime roots;
- production config validation;
- health/readiness/metrics discipline;
- queue and worker operational discipline;
- Remnawave provider-boundary thinking;
- safe API/runtime behavior.

### `remnawave-STEALTHNET-Bot-4.0.0` donor

This is the user-facing donor for Reiwa. Live-code audit found these relevant capabilities:

- Express API runtime plus Telegram bot runtime.
- PostgreSQL/Prisma business schema for clients, bots, payments, tariffs, gifts, tickets, contests, marketplace, landing, proxy/singbox, notifications, referrals, and audits.
- Client auth via Telegram, web login, OAuth-like flows, 2FA, and account recovery.
- Public config endpoint consumed by bot/frontend.
- Telegram bot API client with registration, login, link, tariffs, contests, payments, subscription and gift flows.
- Scheduler-heavy implementation for auto-renew, broadcast, contest reminders, backup, gifts, abandoned accounts, and marketplace heartbeat.

## Reiwa target boundaries

### Reiwa owns

- Public user API.
- Telegram bot runtime.
- Future Telegram Mini App / user web runtime.
- User sessions and public-safe account surface.
- User-facing subscription, payment, device, referral, gift, support, and notification UX.

### `rezeis-admin` owns

- Operator/admin panel.
- Business truth that is already implemented there: payments, plans, promocodes, referrals, partners, notifications, imports, backup/restore, governance, Remnawave operator workflows.
- Internal contracts consumed by Reiwa where truth must stay admin-owned.

### Remnawave owns

- VPN/control-plane primitives.
- Nodes, hosts, config profiles, provider-side subscription/device state.

Reiwa must integrate through safe server-side seams. The browser must not directly consume Remnawave provider identifiers, URLs, UUIDs, tokens, profile/config links, or device internals.

## Runtime architecture

Initial Reiwa runtime contract:

```text
reiwa/
  src/api/main.ts      public user API runtime
  src/bot/main.ts      Telegram bot runtime
  src/worker/main.ts   future background worker runtime
  src/config.ts        typed environment seam
```

Future production split:

- `reiwa-api`: HTTP API for user web/Mini App and public bot callbacks.
- `reiwa-bot`: Telegram bot update handling.
- `reiwa-worker`: queued/background jobs after concrete scheduled responsibilities are defined.
- `reiwa-web`: user web/Mini App frontend after backend contracts stabilize.

## First implementation phases

1. Runtime and config foundation.
2. Public config and branding contract.
3. Session/auth contract.
4. Plans and subscription read contract.
5. Quote/checkout/status contract.
6. Promocode activation contract.
7. Referral/gift/support contracts.
8. Telegram bot handlers.
9. User web/Mini App.

## RUID removal boundary

`ruid` is deleted as a runtime and source tree. Historical docs that mention `ruid` should be treated as stale until rewritten to Reiwa terminology.

The immediate replacement is a scaffolded Reiwa architecture, not a finished user product.
