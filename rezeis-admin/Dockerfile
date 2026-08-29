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
ENV HUSKY=0
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
# ── OS packages, patched at build time ─────────────────────────────────────
#
# `node:24-alpine` is rebuilt on its own schedule, so between two of its
# rebuilds this image inherits whatever OpenSSL that snapshot happened to ship.
# Trivy found ten CVEs that way — `libssl3` 3.5.7-r0 against a fixed 3.5.8-r0 —
# and every one of them was already patched in Alpine's repository at the time.
# Nothing was wrong with the code; the image was simply older than the fix.
#
# Upgrading here closes that window without waiting for upstream. The cost is
# that the same Dockerfile no longer produces byte-identical images over time,
# and for a RUNTIME image that is the right side of the trade: the alternative
# is shipping known-vulnerable libraries on purpose so that rebuilds match.
#
# `--no-cache` keeps the package index out of the layer.
#
# ── WHY THIS LAYER MUST NOT BE A CACHE HIT ────────────────────────────────
#
# It is the first instruction of the stage, so its cache key is just the base
# image plus this literal command — and the build passes `cache-from: type=gha`.
# Left alone, the layer restored verbatim on every later build: the step added
# to patch twenty CVEs would have quietly re-shipped the exact `libssl3` it was
# written to replace, with `CACHED` in the log and Trivy re-reporting the same
# advisories after the push, failing nothing.
#
# `SECURITY_REFRESH` carries the commit sha, so the key changes whenever the
# source does and the upgrade genuinely re-runs. It costs a few seconds and it
# is the only thing making this layer mean what it says.
#
# Scope, stated plainly: this upgrades apk-managed packages within the base
# image's pinned Alpine branch — patch level only, never a new major. Node
# itself is not an apk package here, so Node's own CVEs still arrive with the
# base tag.
ARG SECURITY_REFRESH=dev
RUN echo "security refresh ${SECURITY_REFRESH}" && apk upgrade --no-cache

RUN addgroup -g 1001 -S rezeis && adduser -u 1001 -S rezeis -G rezeis

WORKDIR /app
ENV NODE_ENV=production
# App metadata baked into the image so health endpoint reports the release.
# A local image is a development build, not an older release. The release
# workflow always supplies the exact package version as this build argument.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ARG GIT_BRANCH=unknown
ENV APP_VERSION=${APP_VERSION} \
    REZEIS_GIT_SHA=${GIT_SHA} \
    REZEIS_GIT_BRANCH=${GIT_BRANCH} \
    npm_package_version=${APP_VERSION}

# Install PostgreSQL client tools (pg_dump, psql) for backup/restore.
# MUST match the major version of the postgres server (see docker-compose.yml).
# su-exec lets the root entrypoint repair data-volume ownership, then drop
# privileges to the unprivileged `rezeis` user before running the app.
RUN apk add --no-cache postgresql17-client su-exec

# The official Node image includes npm for build-time use. The runtime only
# executes Node and the app-local Prisma CLI, so remove npm and npx (plus their
# bundled dependency tree) to keep unrelated npm CVEs out of this final image.
RUN rm -rf /usr/local/lib/node_modules/npm \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY package.json ./
COPY prisma.config.ts ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build-backend /app/dist ./dist
COPY --from=build-backend /app/prisma ./prisma
COPY --from=build-backend /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build-frontend /app/dist ./web

RUN mkdir -p /app/data/backups /app/data/uploads \
 && chmod +x /usr/local/bin/docker-entrypoint.sh \
 && chown -R rezeis:rezeis /app

# The container starts as root so the entrypoint can repair the persistent
# data-volume ownership (named/host volumes can be root-owned on upgrade),
# then drops to the unprivileged `rezeis` user via su-exec before exec'ing
# the app. The application process therefore never runs as root.

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
