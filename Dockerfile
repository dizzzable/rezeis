FROM node:22-alpine AS base

WORKDIR /app

FROM base AS dependencies

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS build

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY src ./src
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma

RUN mkdir -p /app/data/backups

EXPOSE 8000

CMD ["node", "dist/main.js"]
