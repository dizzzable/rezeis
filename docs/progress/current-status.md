# Current Status

Updated: 2026-05-10 — Full rebuild complete.

---

## Stack

### Backend (rezeis-admin)
| Technology | Version |
|---|---|
| NestJS | 11.1.19 |
| Prisma | 7.8.0 |
| TypeScript | 6.0.3 |
| Node.js | 24+ |
| PostgreSQL | 15 |
| Redis | 7 |
| BullMQ | 5.76.6 |
| zod | 4.4.3 |
| @remnawave/backend-contract | 2.8.1 |

### Frontend (rezeis-admin/web)
| Technology | Version |
|---|---|
| React | 19.2.6 |
| Vite | 8.0.11 |
| Tailwind CSS | 4.3.0 |
| TypeScript | 6.0.3 |
| TanStack Query | 5.100.9 |
| React Router | 7.15.0 |
| shadcn/ui | latest |
| Vitest | 4.1.5 |

---

## Architecture

```
rezeis/
├── rezeis-admin/          NestJS 11 backend (admin API + business logic)
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
| remnawave | Full typed API via @remnawave/backend-contract (15+ endpoints) |

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
- Node.js 22+

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
