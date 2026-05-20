# rezeis-admin

**Operator control plane for Rezeis** — a NestJS backend with a paired React/Vite SPA that operators use to manage every part of a Remnawave-backed VPN business: customers, subscriptions, plans, payments, partners, promocodes, and the bot that talks to end-users.

Rezeis as a whole has two halves:

- **`rezeis-admin`** (this repo) — operator/admin truth: CRUD, RBAC, audit, billing, automations, queues. Source of truth for all business state.
- **[`reiwa`](https://github.com/dizzzable/reiwa)** — user-facing edge: Telegram bot, public web, payment return flows. Talks to `rezeis-admin` over a versioned internal HTTP API.

> **Version:** `0.1.0` · **Status:** initial public release · **License:** UNLICENSED (private)

---

## What rezeis-admin does

### Customer & subscription operations

- **Users module** — full operator cockpit for every customer: search, filter, bulk import (CSV), bulk operations (block/unblock, role change, language reset, traffic reset), and a deep per-user detail panel with subscriptions, devices, linked Telegram/web accounts, support history, and audit timeline.
- **Subscriptions** — assign, extend, downgrade, mark trial, reset traffic/devices, sync to Remnawave, generate quote previews. Plan snapshots are taken at sale time so retroactive plan edits never silently mutate active subscriptions.
- **Plans** — CRUD over the catalog with traffic/device/duration matrix, payment-asset eligibility, per-plan stats (revenue, conversions, churn), and visibility controls (public, private, partner-only, allowed-list).
- **Devices** — view active HWIDs per user, revoke, regenerate provisioning tokens, sync against the Remnawave inventory.

### Money

- **Payment gateways** — pluggable provider registry. Webhook ingress with signature verification, normalization, idempotency, and a dedicated webhook ops console (replay, mark-paid, mark-failed, payload redaction). Built-in adapters for the providers that altshop ships, plus AntilopayAPI.
- **Transactions** — full ledger with provider IDs, reconciliation against the gateway, manual mark-paid for offline payments, refund flows.
- **Reconciliation** — scheduled job that pulls provider transactions and flags drift against local state.
- **Auto-renew** — opt-in renewal job with grace periods, dry-run, and per-plan toggles.

### Growth

- **Promocodes** — value/percentage/free-days/free-traffic codes with usage limits, plan scoping, partner attribution, and per-code metrics. Property-based tests cover activation, validation, and reward flows.
- **Referrals** — multi-tier referral program with qualification rules, referral exchange (transfer balance between partners), and bounded contexts for referral rewards vs. user invites.
- **Partners** — partner program with custom commission rates, individual settings overrides, withdrawal requests with approval workflow, partner-scoped settings, and a per-partner statistics view.
- **Contests** & **Add-ons** — promotional contests and à-la-carte add-on purchases on top of an active subscription.

### Operations & observability

- **Dashboard** — revenue/MRR, active subscriptions over time, device load, geographic breakdown, partner contribution, churn, and an at-a-glance health panel.
- **Business analytics** — deeper drilldowns: cohort retention, ARPU per plan, payment funnel.
- **System logs** — structured logs with HTTP request correlation, admin actions, and queued job traces.
- **Audit** — append-only audit log for every admin action, exportable per-entity.
- **Imports** — CSV import for users with column mapping, dry-run, and idempotent re-runs.
- **Backup** — schedule, run, and restore database snapshots through the panel.
- **Update checker** — surface available rezeis-admin/reiwa upgrades.
- **Config portability** — export/import the admin's full operational config as JSON.

### Security & access control

- **RBAC** — role/permission matrix with custom roles, per-module gates, and inline diff in the UI when an operator edits a role.
- **Two-factor (2FA)** — TOTP with recovery codes for admins.
- **API tokens** — operators issue Bearer JWT tokens scoped to internal endpoints (consumed by reiwa).
- **IP allowlists** — restrict admin login by IP/CIDR ranges.
- **Blocked IPs** — block list for end-users with manual and automated entries.
- **Anti-fraud signals** — per-user fraud scoring and signal log (device fingerprints, payment-attempt anomalies, geo-velocity).
- **HMAC request signing** — optional `x-request-signature` header for service-to-service calls.

### Communication

- **Notifications catalog** — per-event notification toggles (subscription expiring, payment failed, device added, etc.) with separate channels for bot, email, and push.
- **Broadcast** — one-shot announcements to user segments via the bot, with preview, dry-run, and delivery telemetry.
- **Email** — transactional emails (verification, password recovery, receipts) with delivery exception handling.
- **Push** — web push subscription registry per user.
- **Support tickets** — operator side of customer support: thread view, internal notes, canned replies, attachments.
- **FAQ** — content management for the FAQ rendered inside the bot/Mini App, with markdown and media embedding.
- **Webhooks (outbound)** — sign and dispatch outbound webhooks to operator-configured endpoints on key business events.

### Customization & content

- **Branding** — name, logo, colors, theme presets (light/dark + custom palettes) applied to both panel and reiwa.
- **Theme presets** — saved color/typography bundles operators can switch between.
- **Bot config** — bot-side settings that apply to reiwa: welcome copy, menu buttons, support link, mini-app URL.
- **Settings hub** — platform-wide knobs: payment toggles, registration policy, locale defaults, Telegram delivery options, panel access mode.

### Integration with Remnawave

- **Remnawave module** — typed HTTP client for the Remnawave panel. Server-side only — Remnawave URLs/tokens never reach the browser.
- **Profile sync** — queue + worker that keeps Remnawave profiles in sync with subscription mutations (plan change → re-provision squad/devices).
- **Subscription mutations** — mediated Remnawave updates with rollback and retry.

### Background work

- **BullMQ** — typed queues with global concurrency limits, observability, and duplicate-inspection helpers.
- **Worker process** — separate `dist/worker.js` entrypoint, same image, started via `CMD ["node", "dist/worker.js"]`.

### Real-time

- **WebSocket gateway** — Socket.IO room-based push for the admin panel (e.g. live-update of webhook deliveries, fraud signals, dashboards).

---

## Architecture

```
                       ┌──────────────────────────────────────┐
                       │           rezeis-admin SPA           │
                       │   React 19 · Vite 8 · TanStack 5     │
                       │      shadcn/ui · Tailwind 4          │
                       └────────────────┬─────────────────────┘
                                        │ JWT (admin login)
                                        ▼
┌──────────────────┐ webhooks ┌──────────────────────────────────────┐
│ Payment provider │ ───────▶ │           rezeis-admin API           │
└──────────────────┘          │ NestJS 11 · 40+ feature modules      │
                              │ Prisma 7 · Zod · class-validator     │
                              └─────┬─────┬─────┬────────────────┬───┘
                                    │     │     │                │
                       ┌────────────▼─┐ ┌─▼────┐│      ┌─────────▼────┐
                       │  PostgreSQL  │ │ Redis│└────▶ │ Remnawave API│
                       │ (Prisma ORM) │ │ +    │       │  (HTTPS)     │
                       └──────────────┘ │ Bull │       └──────────────┘
                                        └──┬───┘
                                           │
                              ┌────────────▼────────────┐
                              │  rezeis-admin worker    │
                              │  (same image, dist/     │
                              │   worker.js)            │
                              └─────────────────────────┘
                                           ▲
                                           │ Bearer + HMAC (optional)
                                           │
                              ┌────────────┴────────────┐
                              │         reiwa           │
                              │ (separate repo, talks   │
                              │  only over HTTP)        │
                              └─────────────────────────┘
```

### Tech stack

| Layer | Tech |
|---|---|
| API | NestJS 11, Express 5, Helmet, Passport JWT |
| ORM | Prisma 7 (`@prisma/adapter-pg`) on PostgreSQL |
| Cache & queues | ioredis 5, BullMQ 5 |
| Validation | zod 4, class-validator |
| Real-time | Socket.IO 4 |
| Logging | nest-winston, structured JSON logs |
| Tests | `node --test` + Vitest (frontend), property-based tests via `fast-check` |
| Frontend | React 19, Vite 8, TanStack Query 5, react-hook-form 7, Zustand 5 |
| UI | shadcn/ui (Radix), Tailwind 4, Motion (framer-motion), Recharts 3 |
| i18n | i18next 26, react-i18next 17 (RU/EN) |
| Quality | ESLint 10, TypeScript 6, [`react-doctor`](https://github.com/millionco/react-doctor) on every PR |

### Layout

```
.
├── src/                       NestJS application + worker
│   ├── app.module.ts
│   ├── main.ts                API entrypoint  → dist/main.js
│   ├── worker.ts              Worker entrypoint → dist/worker.js
│   ├── common/                shared infra (config, guards, filters,
│   │                          interceptors, logger, queue helpers, ...)
│   └── modules/               40+ feature modules (see "What it does" above)
├── prisma/
│   ├── schema.prisma          single-file schema
│   └── migrations/            timestamped, append-only
├── web/                       React/Vite admin SPA (built into unified image)
│   ├── src/
│   │   ├── app/               router, providers, protected routes
│   │   ├── components/        layout + shared shadcn/ui wrappers
│   │   ├── features/          one folder per admin page/domain (≈35)
│   │   ├── i18n/              ru.ts, en.ts
│   │   ├── lib/               api.ts (axios + auth interceptor), motion, utils
│   │   └── stores/            Zustand stores (auth, locale, ...)
│   └── nginx.conf             (optional, for standalone nginx deploy)
├── test/                      backend unit + property-based tests
├── Dockerfile                 unified multi-stage image (API + SPA + worker)
└── docker-compose.yml         production stack (remnawave-network)
```

---

## Quick start

### Prerequisites

- Node.js 22 (matches the Docker base image)
- PostgreSQL 15+
- Redis 7+

### Backend

```bash
git clone https://github.com/dizzzable/rezeis.git
cd rezeis
npm install
cp .env.example .env             # fill in DATABASE_URL, REDIS_URL, secrets
npx prisma generate
npx prisma migrate deploy
npm run start:dev                # API on :8000

# In another terminal:
node dist/worker.js              # background worker (uses the same .env)
```

### Frontend

```bash
cd web
npm install
cp .env.example .env             # set VITE_API_URL=http://localhost:8000
npm run dev                      # SPA on :5173
```

Default admin login is created on first boot from `ADMIN_*` environment variables — see `.env.example`.

---

## Build

### Local Docker

```bash
docker build -t rezeis .
docker compose up -d
```

### Container images (GHCR)

A single unified image is pushed automatically on every push to `main` and on every `v*` tag:

```
ghcr.io/dizzzable/rezeis:0.1.0
ghcr.io/dizzzable/rezeis:latest
ghcr.io/dizzzable/rezeis:sha-<short>
```

The image runs `node dist/main.js` by default (API + SPA on port 8000). To run the worker from the same image:

```bash
docker run --rm \
  --env-file .env \
  ghcr.io/dizzzable/rezeis:0.1.0 \
  node dist/worker.js
```

### Deployment with reverse proxy

Rezeis runs in `remnawave-network` alongside Remnawave Panel. If you already have Traefik/Caddy configured for Remnawave, just add another router pointing to `http://rezeis:8000`.

**Traefik example** (`/opt/remnawave/traefik/config/rezeis.yml`):

```yaml
http:
  routers:
    rezeis:
      rule: "Host(`admin.yourdomain.com`)"
      entrypoints:
        - https
      tls:
        certResolver: letsencrypt
      service: rezeis

  services:
    rezeis:
      loadBalancer:
        servers:
          - url: "http://rezeis:8000"
```

**Caddy example** (add to Caddyfile):

```
admin.yourdomain.com {
    reverse_proxy rezeis:8000
}
```

---

## Quality gates

A push to `main` and every PR runs:

```bash
# Backend
npm run typecheck                # tsc --noEmit
npx eslint . --quiet             # 0 warnings policy

# Frontend
cd web
npx tsc -p tsconfig.app.json --noEmit
npx eslint . --quiet
npm run build                    # tsc + vite build
npm run doctor                   # react-doctor scan
```

The [react-doctor](https://github.com/millionco/react-doctor) action posts a PR comment with a 0–100 health score plus diagnostics across state, effects, performance, architecture, security, and accessibility. Configured with `--fail-on error` so error-severity findings block the PR; warnings are advisory.

---

## Internal API for reiwa

Operators issue per-service Bearer JWTs from **Settings → API tokens** in the panel. Reiwa uses one such token plus an optional HMAC shared secret (`REZEIS_INTERNAL_SHARED_SECRET`) to call:

| Endpoint group | Purpose |
|---|---|
| `/internal/users/*` | profile lookup, linked accounts, devices, activity |
| `/internal/subscriptions/*` | quote, purchase, extend, downgrade |
| `/internal/payments/*` | provider registry, checkout creation, transactions |
| `/internal/plans/*` | public plan catalog (with reiwa-safe fields only) |
| `/internal/promocodes/*` | activation, validation |
| `/internal/referrals/*` | referral status, rewards, exchange |
| `/internal/partners/*` | partner status |
| `/internal/support/*` | open ticket, post message |
| `/internal/branding/*` | reiwa pulls live branding from here |
| `/internal/notifications/*` | event delivery to bot/email/push |

All `/internal/*` endpoints are guarded by `InternalApiGuard` — no public access, no admin login.

---

## Contributing

Branches:

- `main` — protected, production-ready.
- `dev` — integration. Feature branches merge here first.
- `feature/<short>` and `hotfix/<issue>` for individual changes.

Commits follow Conventional Commits with scope: `feat(admin): …`, `fix(web): …`, `refactor(prisma): …`, `chore(ci): …`.

Pre-push checklist (also runs in CI):

1. `npx tsc --noEmit -p tsconfig.json`
2. `npx eslint . --quiet`
3. `cd web && npm run build`
4. `cd web && npx eslint . --quiet`
5. `npm test` for changed modules
