# rezeis-admin

Rezeis Admin — NestJS backend + React/Vite frontend for the admin panel.

- **Version:** `0.7.3`
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

`rezeis-admin` talks to a Remnawave panel through the `@remnawave/backend-contract` package. **The contract version must track the live panel.**

| Live panel       | `@remnawave/backend-contract` | Notes                                                              |
|------------------|-------------------------------|--------------------------------------------------------------------|
| `2.7.x`          | `~2.7.3` (current pin)        | No `/api/system/recap`, `/api/system/bandwidth`, `/api/hwid/stats` |
| `2.8.x`          | `~2.8.x`                      | Adds the recap/bandwidth/hwid surface                              |

If you upgrade the live panel, bump the contract dep accordingly and run `npm install`. The Remnawave page in the admin SPA degrades gracefully when an endpoint is missing (shows a "metric is unavailable" notice instead of crashing).

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

- `ghcr.io/dizzzable/rezeis:0.7.3`
- `ghcr.io/dizzzable/rezeis:0.7`
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
