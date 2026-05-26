# ══════════════════════════════════════════════════════════════════════════════
#  rezeis — unified image (API + Worker + SPA)
#
#  Single image serves:
#    • NestJS API on port 8000 (default CMD)
#    • Background worker: override CMD to ["node", "dist/worker.js"]
#    • Admin SPA: served by NestJS via @nestjs/serve-static from /app/web/
#
#  Connects to remnawave-network so it can reach remnawave:3000 directly.
# ══════════════════════════════════════════════════════════════════════════════

# ── Stage 1: install production deps ─────────────────────────────────────────
FROM node:24-alpine AS dependencies

WORKDIR /app
# Install build tools for native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: build backend ───────────────────────────────────────────────────
FROM node:24-alpine AS build-backend

WORKDIR /app
# Install build tools for native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY src ./src
RUN npx prisma generate && npm run build

# ── Stage 3: build frontend ──────────────────────────────────────────────────
FROM node:24-alpine AS build-frontend

WORKDIR /app
COPY web/package.json web/package-lock.json web/.npmrc ./
RUN npm ci
COPY web/ .
RUN npm run build

# ── Stage 4: runtime ─────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
# App version baked into the image so health endpoint reports it.
# Updated automatically via package.json bump → Docker build.
ARG APP_VERSION=0.3.7
ENV npm_package_version=${APP_VERSION}

# Install PostgreSQL client tools (pg_dump, psql) for backup/restore.
# MUST match the major version of the postgres server (see docker-compose.yml).
RUN apk add --no-cache postgresql17-client

COPY package.json ./
COPY prisma.config.ts ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build-backend /app/dist ./dist
COPY --from=build-backend /app/prisma ./prisma
COPY --from=build-backend /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build-frontend /app/dist ./web

RUN mkdir -p /app/data/backups /app/data/uploads \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
