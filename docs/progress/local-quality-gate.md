# Local Quality Gate — Rezeis Admin

## Pre-flight checklist before first run

### Step 1 — Install dependencies

```bash
# Backend
cd rezeis-admin
npm install

# Web panel
cd rezeis-admin/web
npm install

# Reiwa user service
cd reiwa
npm install
```

### Step 2 — Generate Prisma client (REQUIRED before backend starts)

```bash
cd rezeis-admin
npm run prisma:generate
```

After this runs, you MUST replace all `(this.prisma as any).modelName` calls with
typed `this.prisma.modelName`. The `src/common/types/prisma-enums.ts` string literal
types can also be replaced with imports from `@prisma/client`.

### Step 3 — Create database migration

```bash
cd rezeis-admin
npm run prisma:migrate:dev -- --name init
```

### Step 4 — Set up environment

```bash
cp rezeis-admin/.env.example rezeis-admin/.env
# Fill in:
#   REZEIS_ADMIN_JWT_SECRET  (min 32 chars)
#   REZEIS_ADMIN_INTERNAL_API_KEY  (min 16 chars)
#   REMNAWAVE_HOST, REMNAWAVE_PORT, REMNAWAVE_TOKEN
#   FRONT_END_DOMAIN  (e.g. http://localhost:3000 for dev)
```

### Step 5 — Start services

```bash
# Option A: Docker Compose (recommended)
cd rezeis
docker-compose up -d

# Option B: Local dev
cd rezeis-admin && npm run dev        # port 3100
cd rezeis-admin/web && npm run dev    # port 5173
cd reiwa && npm run dev:api           # port 8100
cd reiwa && npm run dev:bot           # Telegram bot
```

### Step 6 — Bootstrap first admin

```bash
curl -X POST http://localhost:3100/api/internal/bootstrap-admin \
  -H "Content-Type: application/json" \
  -H "x-internal-api-key: YOUR_INTERNAL_API_KEY" \
  -d '{"username":"admin","password":"yourpassword"}'
```

Then sign in at http://localhost:5173/sign-in (dev) or http://localhost:3000/sign-in (Docker).

---

## Quality verification sequence

```bash
# 1. Backend lint
cd rezeis-admin && npm run lint

# 2. Backend tests
cd rezeis-admin && npm test

# 3. Web panel build (validates TypeScript)
cd rezeis-admin/web && npm run build

# 4. Reiwa TypeScript check
cd reiwa && npm run check
```

---

## Post-`prisma generate` cleanup

After running `npm run prisma:generate`, do these refactors:

1. **Replace `(this.prisma as any)` casts** with typed calls:
   ```typescript
   // Before:
   await (this.prisma as any).admin.findUnique(...)
   // After:
   await this.prisma.admin.findUnique(...)
   ```

2. **Replace inline string literal type aliases** with `@prisma/client` imports:
   ```typescript
   // Before (in service files):
   type SubscriptionStatus = 'ACTIVE' | 'DISABLED' | ...
   // After:
   import { SubscriptionStatus } from '@prisma/client'
   ```

3. **Delete** `src/common/types/prisma-enums.ts` (becomes redundant)

4. **Set `strict: true`** in `tsconfig.json` (was disabled to allow `as any` casts)

---

## Known limitations (intentional)

| Item | Status | Notes |
|------|--------|-------|
| Payment gateway checkout URLs | Stubbed | Returns mock URL; real provider integration needs credentials |
| Backup pg_dump | Stubbed | Creates DB record; actual dump not implemented |
| Broadcast delivery | BullMQ ready | Processor exists but no Telegram Bot API call yet (requires BOT_TOKEN) |
| Email sending | Requires SMTP | Set SMTP_* env vars for password recovery emails |
| HWID device management | Phase 1 only | Device list + revoke, no assignment changes |
| Auto-renewal scheduler | Placeholder | Worker skeleton ready, needs cron job implementation |

---

## Architecture decisions (final)

| Decision | Choice | Reason |
|----------|--------|--------|
| Validation | `class-validator` | Works without Prisma generate; nestjs-zod requires full setup |
| BigInt serialization | `BigInt.prototype.toJSON` global | Set in main.ts before all imports (same as backend-main) |
| Error format | `HttpExceptionFilter` global | Consistent `{statusCode, message, error, timestamp, path}` |
| CORS | `FRONT_END_DOMAIN` env var | Configurable per deployment; array-split for multi-domain |
| Worker entrypoint | Separate `worker.ts` | Isolated process for BullMQ; same pattern as backend-main |
| Auth tokens | JWT Bearer | Standard; `REZEIS_ADMIN_JWT_SECRET` min 32 chars |
| Internal API | `x-internal-api-key` header | Simple shared secret for bot→admin calls |
