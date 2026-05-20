# rezeis-admin

Rezeis Admin — NestJS backend + React/Vite frontend for the admin panel.

- **Version:** `0.1.0`
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

- `ghcr.io/dizzzable/rezeis-api:0.1.0`
- `ghcr.io/dizzzable/rezeis-web:0.1.0`

Local build:

```bash
docker compose build
docker compose up
```

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
