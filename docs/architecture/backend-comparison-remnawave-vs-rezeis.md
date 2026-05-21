# Backend Comparison: Remnawave Panel vs Rezeis Admin

> Reference study performed against `backend-main` (Remnawave NestJS panel).  
> Rezeis Admin is NOT a clone — it is a separate business-logic panel.  
> backend-main serves as an **engineering-patterns donor only**.

---

## Purpose Difference

| Aspect | backend-main (Remnawave) | rezeis-admin |
|--------|--------------------------|--------------|
| Domain | VPN control plane (nodes, hosts, config, subscriptions) | Business admin panel (shop logic, payments, users, promos, referrals) |
| Users | VPN operators / API clients | Shop admins / Telegram bot backend |
| Database | Remnawave own schema | Altshop-derived schema (translated from Python SQLAlchemy) |
| Auth | JWT + Passkey + OAuth2 | JWT only (admin panel) + internal API key (bot) |

---

## Architecture Patterns Comparison

| Pattern | backend-main | rezeis-admin | Status |
|---------|-------------|-------------|--------|
| BigInt global JSON serialization | ✅ `main.ts` first line | ✅ Fixed — added to `main.ts` | ✅ |
| Global HTTP Exception Filter | ✅ `@UseFilters(HttpExceptionFilter)` | ✅ Fixed — `useGlobalFilters` in main.ts | ✅ |
| Response envelope `{response: data}` | ✅ Consistent | ❌ Raw data returned | ⚠️ Intentional diff |
| CQRS Commands/Queries | ✅ All modules | ❌ Flat service files | 🔵 Acceptable for scope |
| `nestjs-zod` + ZodValidationPipe | ✅ Zod-first | ❌ `class-validator` + `ValidationPipe` | 🔵 Works, different choice |
| `@libs/contracts` typed API | ✅ Contract package | ❌ Inline string routes | 🔵 Acceptable for scope |
| Roles Guard (`@Roles`, `RolesGuard`) | ✅ `ROLE.ADMIN`, `ROLE.API` | ⚠️ Only `isActive` admin check | 🟡 Can improve |
| API Tokens CRUD module | ✅ Full module | ❌ Missing | 🟡 Future work |
| Health with DB/Redis probes | ✅ `@nestjs/terminus` | ✅ Fixed — DB probe added | ✅ |
| Winston structured logging | ✅ `nest-winston` | ❌ Basic NestJS `Logger` | 🔵 Low priority |
| Compression middleware | ✅ `compression` | ✅ Present | ✅ |
| Morgan HTTP logging | ✅ Optional | ❌ Missing | 🔵 Low priority |
| ConditionalModule (api/worker) | ✅ `isRestApi()` guard | ✅ Separate `worker.ts` entry | ✅ |
| Swagger always enabled | ✅ | ✅ Fixed — removed dev-only guard | ✅ |
| Shutdown hooks | ✅ | ✅ Fixed — added | ✅ |
| CORS production config | ✅ `FRONT_END_DOMAIN` | ✅ Fixed — reads `FRONT_END_DOMAIN` | ✅ |
| `@Public()` decorator | ✅ | ✅ Fixed — created | ✅ |

---

## Modules Present

### backend-main modules (Remnawave VPN control plane)
These are Remnawave-specific and **NOT needed in rezeis-admin**:

| Module | Purpose | In rezeis-admin? |
|--------|---------|-----------------|
| `nodes` | VPN node CRUD + restart/traffic-reset | ✅ Via RemnaWaveService client |
| `hosts` | VPN host management | ❌ Not needed (remnawave owns it) |
| `config-profiles` | VPN config profile templates | ❌ Not needed |
| `internal-squads` | User routing groups | ❌ Stored as UUIDs in subscription |
| `external-squads` | External routing groups | ❌ Same |
| `keygen` | VPN key generation | ❌ RemnaWave handles |
| `subscription-template` | VPN subscription templates | ❌ Not needed |
| `subscription-settings` | VPN sub settings | ❌ Not needed |
| `subscription-response-rules` | SRR matching | ❌ Not needed |
| `subscription-page-configs` | Sub page configs | ❌ Not needed |
| `nodes-traffic-usage-history` | Node traffic stats | ❌ Not needed |
| `nodes-usage-history` | Node usage | ❌ Not needed |
| `nodes-user-usage-history` | Per-user node usage | ❌ Not needed |
| `hwid-user-devices` | HWID device management | 🟡 Planned (Phase 1) |
| `infra-billing` | Infrastructure billing | ❌ Not needed |
| `user-subscription-request-history` | Sub request log | ❌ Not needed |
| `ip-control` | IP blocking | ❌ Not needed |
| `metadata` | System metadata | ⚠️ Partial via SystemStats |
| `api-tokens` | External API token management | 🟡 TODO |

### rezeis-admin modules (Business logic — unique to this panel)
These don't exist in backend-main:

| Module | Purpose | Status |
|--------|---------|--------|
| `plans` | Plan catalog + pricing | ✅ |
| `subscriptions` | Subscription lifecycle + mutations | ✅ |
| `payments` | 14 gateways + webhook inbox + reconciliation | ✅ |
| `promocodes` | Promo lifecycle + activation | ✅ |
| `referrals` | 3-level referral system | ✅ |
| `partners` | Partner earnings + withdrawals | ✅ |
| `broadcast` | Telegram broadcast campaigns | ✅ |
| `notifications` | User notifications + templates | ✅ |
| `backup` | DB backup records | ✅ |
| `imports` | User import (dry-run/commit) | ✅ |
| `internal-user` | Bot → admin user contract | ✅ |
| `dashboard` | KPI summary stats | ✅ |
| `internal-api` | Internal health + bootstrap | ✅ |

---

## Critical Bugs Fixed

### 🔴 Fixed

1. **`InternalUserModule` was a placeholder** → Wired `InternalUserController` + `InternalUserService` + `EmailModule`

2. **`BigInt.prototype.toJSON` not set globally** → Added to `main.ts` as first line (before all imports), exactly like backend-main

3. **`BroadcastService` imported non-existent `@prisma/client` enums** → Replaced with inline string literal types + const objects

4. **All service files `@prisma/client` enum imports** → Fixed across 7 services + 13 DTOs (Prisma client not yet generated — uses string literal type aliases)

5. **No global `HttpExceptionFilter`** → Created `src/common/filters/http-exception.filter.ts` + applied via `useGlobalFilters`

6. **CORS `origin: false` in production** → Now reads `FRONT_END_DOMAIN` env var (comma-separated list → array)

7. **Health check was a bare `{status:ok}` object** → Replaced with `@nestjs/terminus` DB probe (`SELECT 1`)

8. **`WorkerModule` empty — processors wouldn't run** → Wired `PaymentReconciliationProcessor` + `BroadcastProcessor` with all required services

9. **Swagger disabled in production** → Now always enabled at `/api/docs`

10. **No `@Public()` decorator** → Created at `src/common/decorators/public.decorator.ts`; applied to health endpoints

11. **Zod validation: `.errors` instead of `.issues`** → Fixed in `env.schema.ts` (correct Zod v3 API)

12. **JWT strategy missing DB lookup** → Now verifies admin exists AND `isActive === true` on each request

---

## Remaining Gaps (Future Work)

| Gap | Priority | Notes |
|-----|----------|-------|
| API Tokens module | 🟡 Medium | External API access (like Remnawave's `api-tokens`) |
| RBAC fine-grained roles | 🟡 Medium | `@Roles()` + `RolesGuard` for admin permission levels |
| Winston structured logging | 🟢 Low | Better observability in production |
| Morgan HTTP access logging | 🟢 Low | Track all HTTP requests |
| Response envelope `{response:}` | 🔵 Optional | backend-main wraps all responses — rezeis-admin returns raw data (both valid choices) |
| `@UseFilters(HttpExceptionFilter)` per-controller | 🔵 Optional | Currently applied globally — per-controller is more granular |
| Prometheus metrics | 🔵 Optional | `prom-client` + `/metrics` endpoint |
| Prisma `$queryRaw` typed | 🔵 Low | After `prisma generate` remove all `(this.prisma as any)` casts |

---

## What Must Be Done Before First Run

```bash
cd rezeis-admin

# 1. Install dependencies
npm install

# 2. Generate Prisma client from schema
npm run prisma:generate

# 3. Create and run database migration
npm run prisma:migrate:dev -- --name init

# 4. Start in development mode
npm run dev

# 5. Bootstrap first admin (one-time)
curl -X POST http://localhost:3100/api/internal/bootstrap-admin \
  -H "Content-Type: application/json" \
  -H "x-internal-api-key: YOUR_INTERNAL_API_KEY" \
  -d '{"username":"admin","password":"changeme123"}'
```

After `prisma generate` runs:
- Remove all `(this.prisma as any)` casts → replace with proper typed `this.prisma.modelName`
- Remove inline string literal type aliases → import from `@prisma/client`
- The `src/common/types/prisma-enums.ts` file becomes a fallback reference only
