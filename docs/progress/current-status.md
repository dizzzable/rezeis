# Current Status

Updated: 2026-09-14 — the Stack tables (PostgreSQL and Valkey read from the images in `rezeis-admin/docker-compose.yml`, Node.js from the Dockerfile base image, the package rows from the lockfiles; `shadcn/ui` is copied-in source with no version), the architecture line for NestJS, the Remnawave contract paragraph and the `remnawave` module row only. The status section directly below is from 2026-08-23 and has not been re-checked since.

## Current Remnawave Status

- Upstream PR: https://github.com/dizzzable/rezeis/pull/40
- Baseline: Rezeis Admin `v0.9.7.17`
- Target: Remnawave Backend `v3.3.2`
- The Remnawave sync-state slice is one part of a much larger uncommitted working tree. It is NOT "six files": `git status --porcelain` in `rezeis` reports **over four hundred changed paths** — roughly 130 under `rezeis-admin/src/modules` spanning ~30 modules, ~145 under `rezeis-admin/web/src`, and ~90 new specs under `rezeis-admin/test`, plus `prisma/`, `scripts/` and docs. No exact count is quoted here on purpose: the tree is still moving. Run `git status --porcelain` yourself before quoting a scope from this file.
- **Reiwa is NOT untouched** — `git status --porcelain` in `reiwa` shows changes there too, and one of them is a live cross-repo coupling: `internal-partner.controller.ts` now emits `referralPoints` (`User.points`) on the internal partner payload, and `reiwa/src/bot/pages/invite.ts` reads it. The reiwa side reads it as optional on purpose — an older panel sends nothing — so an old cabinet against a new panel degrades rather than breaks, but the two repos still ship together for that field.
- Fork backend/web quality checks passed; the fork-only React Doctor failure was a base-branch mismatch and is not a finding in the changed frontend files when compared with `v0.9.7.17`.
- Do not merge or deploy until upstream review and CI are complete.

---

## Stack

### Backend (rezeis-admin)
| Technology | Version |
|---|---|
| NestJS | 12.0.1 |
| Prisma | 7.9.0 |
| TypeScript | 6.0.3 |
| Node.js | 24+ |
| PostgreSQL | 17 |
| Valkey (Redis) | 9 |
| BullMQ | 5.76.10 |
| zod | 4.5.4 |

**No `@remnawave/*` package runs at runtime** — `npm ls --omit=dev` lists none, and `test/panel-command-conformance.spec.ts` fails if one appears. The 21 commands production issues live in rezeis's own table, `rezeis-admin/src/modules/remnawave/services/panel-commands.ts`: it validates and sends the parsed request body and hands responses on raw, and the few readers that need parsed fields use explicit decoders (`panel-response-fields.ts`). The vendor contracts are seven **devDependency** oracles, one per panel release line in the vendor's table at https://docs.rw/sdk/typescript-sdk/: `@remnawave/contract-panel-{2.7,2.8,3.2.1,3.2.3,3.3,3.4.3,3.4.4}` = `@remnawave/backend-contract` 2.7.2, 2.8.35, 3.2.0, 3.2.3, 3.4.2, 3.4.13, 3.4.15. The conformance spec holds the command table to every 3.x one; the 2.7 and 2.8 oracles are not part of that check, and other specs use them (era decoding, the tag rule, the page-size cap). A panel that reports major version 2 gets no command from the users, devices and infra clients: each is refused with `REZEIS_PANEL_TOO_OLD` until the panel is upgraded to 3.x. They are AGPL-3.0-only and `Dockerfile` stage 1 runs `npm ci --omit=dev`, so none ships in the image. A vendor schema describes ONE panel era; parsing live responses with one failed deterministically on healthy panels of another era (`decision-log.md`, 2026-08-23 and 2026-09-13).

### Frontend (rezeis-admin/web)
| Technology | Version |
|---|---|
| React | 19.2.8 |
| Vite | 8.1.5 |
| Tailwind CSS | 4.3.0 |
| TypeScript | 6.0.3 |
| TanStack Query | 5.100.13 |
| React Router | 8.3.0 |
| shadcn/ui | latest |
| Vitest | 4.1.11 |

---

## Architecture

```
rezeis/
├── rezeis-admin/          NestJS 12 backend (admin API + business logic)
│   ├── src/
│   │   ├── common/       Infrastructure (17 modules)
│   │   │   ├── cache/         Redis cache service
│   │   │   ├── config/        Zod env validation + typed configs
│   │   │   ├── errors/        Structured error codes (48 codes)
│   │   │   ├── events/        Event-driven constants
│   │   │   ├── exception/     AppException + Result type
│   │   │   ├── filters/       HTTP exception filter + safe filter
│   │   │   ├── guards/        JWT + Internal API guards
│   │   │   ├── interceptors/  Metrics interceptor
│   │   │   ├── logger/        Winston structured logging
│   │   │   ├── metrics/       Prometheus metrics
│   │   │   ├── middlewares/   Correlation ID + Request logger + Proxy check
│   │   │   ├── pipes/         Zod validation pipe
│   │   │   ├── prisma/        PrismaService (Prisma 7 + pg adapter)
│   │   │   ├── queue/         AbstractQueueService base class
│   │   │   ├── scheduler/     Cron intervals
│   │   │   ├── throttler/     Rate limiting
│   │   │   ├── types/         Result type (ok/fail pattern)
│   │   │   └── utils/         Startup app utilities
│   │   └── modules/      Feature modules (26 total)
│   ├── prisma/            PostgreSQL schema (25 models)
│   └── web/               React 19 + Vite 8 + Tailwind 4 + shadcn/ui
├── reiwa/                 User-facing service (communicates with rezeis-admin)
├── docker-compose.dev.yml Local development (PostgreSQL + Redis)
└── docs/                  Architecture + progress docs
```

---

## Backend Modules (26 total)

### Core
| Module | Description | Endpoints |
|---|---|---|
| auth | Admin login/register (remnawave-style bootstrap) | status, register, login, me |
| admin | Admin CRUD with RBAC (OWNER/ADMIN/SUPPORT) | CRUD /admin/admins |
| health | Terminus probes (DB + Redis) | /health, /health/ping, /health/ready, /health/live |
| audit | Admin action event logging | event logging |
| settings | Platform settings (singleton) | get, update platform/referral/partner/notifications |

### Business Logic (from altshop)
| Module | Description |
|---|---|
| users | User search, detail, block/unblock, stats |
| plans | Plan CRUD with durations + prices |
| subscriptions | Subscription list + stats |
| payments | Transactions, gateways, webhooks, revenue stats |
| promocodes | Promocode CRUD + activations |
| referrals | Invites, referrals, rewards, stats |
| partners | Partner list, withdrawals, approve/reject |
| broadcast | Broadcast CRUD + messages |
| notifications | Templates + user notification events |
| backup | Backup records |
| imports | Import records |

### Remnawave Integration
| Module | Description |
|---|---|
| remnawave | Plain HTTP + local tolerant decoders — no runtime contract package (15+ endpoints; panels 3.x, while 2.x is refused with `REZEIS_PANEL_TOO_OLD`) |

### Advanced Features (from remnawave panel + STEALTHNET)
| Module | Description |
|---|---|
| business-analytics | KPI, churn, funnel, provider comparison |
| anti-fraud | 5 signal detectors (read-only) |
| telegram-notify | Event-driven Telegram notifications to admins |
| auto-renew | Expired subscription detection + expiry notifications |
| quick-search | Unified search across all entities |
| diagnostics | System info, DB stats, entity counts |
| internal-api | REST API for reiwa (platform-policy, catalog) |
| dashboard | Summary stats for admin panel |

---

## Frontend Pages

| Page | Route | Description |
|---|---|---|
| Sign In | /sign-in | Auto-detect register vs login |
| Dashboard | / | Stat cards, recent transactions, subscription breakdown |
| Remnawave | /remnawave | 6 tabs: Overview, Nodes, Hosts, Squads, Profiles, HWID |
| Admins | /admins | Admin management |

---

## Infrastructure Patterns (from remnawave panel)

- ✅ Result type (`ok`/`fail`) — explicit error handling
- ✅ Structured error codes (48 machine-readable codes)
- ✅ Event-driven architecture (EventEmitter2 wildcard)
- ✅ CLS-транзакции (automatic propagation via nestjs-cls)
- ✅ Conditional module loading (API/Worker/Scheduler)
- ✅ AbstractQueueService (BullMQ base class)
- ✅ Zod validation pipe
- ✅ Scheduler intervals (centralized cron expressions)
- ✅ Graceful shutdown (SIGTERM/SIGINT)
- ✅ Swagger conditional (explicit `API_DOCS_ENABLED=true` opt-in in any environment)
- ✅ Body size limits (10MB JSON, 1MB urlencoded)
- ✅ Redis + DB health checks
- ✅ Correlation ID tracing
- ✅ Prometheus metrics
- ✅ Rate limiting (ThrottlerModule)

---

## How to Run

### Prerequisites
- Docker + Docker Compose (for PostgreSQL + Redis)
- Node.js 24 LTS

### Quick start
```bash
cd rezeis

# Start PostgreSQL + Redis
docker compose -f docker-compose.dev.yml up -d postgres redis

# Setup backend
cd rezeis-admin
cp .env.example .env  # Fill in required values
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run build
npm start

# Frontend (separate terminal)
cd rezeis-admin/web
npm install
npm run dev  # http://localhost:5173
```

### First admin
Open http://localhost:5173/sign-in — the app will show a registration form
since no admin exists. Create your first admin (OWNER role).

---

## Next Steps

1. ~~Reiwa bot: multi-language support~~ ✅ Done
2. ~~Reiwa bot: profile/language commands~~ ✅ Done
3. ~~Bot Config: full CRUD (create/delete buttons, emojis, texts)~~ ✅ Done
4. ~~Bot Config: premium emoji support (icon_custom_emoji_id)~~ ✅ Done
5. ~~Internal API: bot-config endpoint for reiwa~~ ✅ Done
6. ~~Internal API: user language update endpoint~~ ✅ Done
7. ~~Reiwa web: i18n (RU/EN) with Telegram/navigator auto-detect~~ ✅ Done
8. ~~Reiwa web: language switcher in settings page~~ ✅ Done
9. ~~Reiwa web: framer-motion → motion/react migration~~ ✅ Done
10. ~~Reiwa web: Vite 8 + React 19 + Tailwind 4 + TS 6 (latest stack)~~ ✅ Done
11. ~~Reiwa web: production build verified~~ ✅ Done
12. ~~Admin panel: Appearance (Themes) page with 9 presets + custom color editor~~ ✅ Done
13. ~~Admin panel: shadcn-themer-style HSL color pickers + border radius slider~~ ✅ Done
14. ~~Admin panel: light/dark/system color mode toggle in top bar~~ ✅ Done
15. ~~Admin panel: motion animations (sidebar slide indicator, page transitions, hover lift)~~ ✅ Done
16. Add i18n keys for Appearance page (en.ts + ru.ts extensions)
17. Implement payment gateway execution (real provider checkout URL)
18. Implement purchase execution (payment webhook → create VPN profile in Remnawave)
19. Add gift codes system
20. Add contest/giveaway system
