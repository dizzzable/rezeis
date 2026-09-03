# rezeis-admin

Rezeis Admin — NestJS backend + React/Vite frontend for the admin panel.

- **Version:** `0.9.7.36`
- **Backend:** NestJS 11 · Prisma 7 · PostgreSQL · Redis · BullMQ
- **Frontend:** React 19 · Vite 8 · TanStack Query 5 · shadcn/ui · Tailwind 4

## Layout

```
.
├── src/                NestJS application + worker
├── prisma/             schema + migrations
├── web/                React/Vite admin SPA
└── docker-compose.yml  full local stack
```

## Remnawave compatibility

`rezeis-admin` talks to a Remnawave panel over plain HTTP and decodes the answers itself. **No `@remnawave/*` package runs at runtime, and there is no contract version to keep in step with the live panel.**

That is deliberate, and it is the fix for a real outage. The adapter used to `safeParse` live responses with `GetExternalSquadsCommand` from `@remnawave/backend-contract@2.7.3`, a production dependency. That schema requires `responseHeaders` on every external-squad row; panel 3.x renamed the field to `responseHeadersAdd` + `responseHeadersRemove`, so the parse failed deterministically and the squad read threw `ServiceUnavailableException` against a perfectly healthy 3.x panel — every time it had at least one external squad. A vendor schema describes ONE era. rezeis serves every era its operators are still running, and they upgrade on their own schedule, so pinning forward would simply have moved the outage onto the installations still on 2.x.

| Live panel | Runtime decoding                                     | Notes                                                              |
|------------|------------------------------------------------------|--------------------------------------------------------------------|
| `2.7.x`    | tolerant local decoders, no vendor package            | No `/api/system/recap`, `/api/system/bandwidth`, `/api/hwid/stats` |
| `2.8.x`    | same                                                  | Adds the recap/bandwidth/hwid surface                              |
| `3.x`      | same                                                  | Numeric user ids, `/api/connections/*` replaces `/api/ip-control/*` |

Upgrading the live panel therefore needs no dependency change here. The Remnawave page in the admin SPA degrades gracefully when an endpoint is missing (shows a "metric is unavailable" notice instead of crashing).

The vendor contracts remain **devDependencies** and are the CI oracle for both eras — `@remnawave/backend-contract` (2.7.3), `@remnawave/contract-v28` (2.8.35), `@remnawave/contract-v3` (3.2.3) and `@remnawave/contract-v34` (3.4.2). The guard specs execute them so a drifting route or row shape fails a test at build time instead of a live panel at run time. They are AGPL-3.0-only, `Dockerfile` stage 1 runs `npm ci --omit=dev`, and none of them ships in the image. Keep it that way: `npm ls --omit=dev @remnawave/backend-contract` must print `(empty)`.

## Quick start

```bash
# Backend
npm install
npx prisma generate
cp .env.example .env  # fill in values
npm run start:dev

# Frontend
cd web
npm install
cp .env.example .env
npm run dev
```

## Build

```bash
# Backend
npm run build           # → dist/main.js + dist/worker.js

# Frontend
cd web && npm run build # → dist/
```

## Docker

Both images are published to GHCR on every push to `main`:

- `ghcr.io/dizzzable/rezeis:v0.9.7.36`
- `ghcr.io/dizzzable/rezeis:0.9.7`
- `ghcr.io/dizzzable/rezeis:sha-<short>`

Local build:

```bash
cp .env.example .env
# Set generated DATABASE_PASSWORD and REDIS_PASSWORD before starting compose.
docker compose build
docker compose up
```

`docker-compose.yml` does not ship production DB/Redis passwords. It requires
`DATABASE_PASSWORD` and `REDIS_PASSWORD` from `.env` or the shell and builds the
runtime DB/Redis connection settings from the split `DATABASE_*` and `REDIS_*`
variables.

The compose stack runs the API container with `RUID_PROCESS_ROLE=api` and the
worker container with `RUID_PROCESS_ROLE=worker` so scheduled jobs and worker
side effects do not double-run in split mode.

## Product surfaces

The admin panel is more than a VPN subscription CRUD surface. Its major
operator-facing areas are:

- **Catalog and lifecycle:** plans, paid/free trials, multi-subscription
  lifecycle, auto-renewal, device and traffic limits, add-ons, and promocodes.
- **Revenue and growth:** 15 payment gateways, checkout/webhook/reconciliation
  operations, payment analytics, referrals, multi-level partners and
  withdrawals, quests, and advertising requests.
- **Support and communications:** broadcasts, event-driven notifications,
  FAQ with media, support tickets and document requests, AI-support controls,
  Bot Studio, custom emoji packs, and Web Landing/Subpage configuration.
- **Infrastructure and operations:** Remnawave provisioning and profile sync,
  dashboard/system health, realtime updates, system events/logs, anti-fraud,
  imports, backups/restores, and configuration portability.
- **Security and governance:** RBAC, admin accounts, API tokens, 2FA,
  passkeys, OAuth/external auth, IP allow/block lists, webhook controls, and
  audit logs.

## WEB Reiwa branding contract

`rezeis-admin` owns the user-facing branding configuration consumed by Reiwa.
The **WEB Reiwa** page persists resolved design tokens rather than requiring
the runtime to look up the admin preset catalog. That keeps the user cabinet
stable across an admin-panel outage or a catalog update.

- **Preset catalog:** eight legacy themes plus 104 conceptual presets. A
  conceptual preset includes palette, app background, surfaces, typography,
  corner radii, card gradient/pattern, and card-effect defaults.
- **Brightness policy:** operators select the concept and a default `light` or
  `dark` representation. `user-selectable` permits users to change only that
  representation; it never grants selection of a different operator theme.
- **Card precedence:** global card controls are the baseline. A positional
  slot inherits those controls by default; an explicit `override` is required
  to change an effect for that subscription position. A slot's static gradient
  remains an independent, deliberate choice. Up to 20 slots are accepted.
- **Contrast and glass:** text policy (`auto`, light, dark, custom) and the
  optional glass composition are independent from effect colours, so a
  contrast decision cannot silently rewrite an operator's gradient.
- **Safe preview/runtime:** the admin preview and Reiwa use matching guarded
  effect runtimes. If Canvas/WebGL is unavailable or fails at runtime, they
  retain the configured gradient and display a CSS fallback of the selected
  effect with the configured palette and opacity.

See the public-runtime details in the [Reiwa README](../../reiwa/README.md#-контракт-брендинга-web-reiwa).

## Quality gates

```bash
# Backend
npm run typecheck
npx eslint . --quiet

# Frontend
cd web
npx tsc -p tsconfig.app.json --noEmit
npx eslint . --quiet
npm run build
npm run doctor          # react-doctor scan
```

A `react-doctor` GitHub Action is configured to comment on every PR touching `web/`.
