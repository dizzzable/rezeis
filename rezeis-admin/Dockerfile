FROM node:22-alpine AS base

WORKDIR /app

FROM base AS dependencies

COPY package.json ./
RUN npm install

FROM base AS build

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY tsconfig.json ./
COPY tsconfig.build.json ./
COPY nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
RUN npm run prisma:generate && npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
RUN npm prune --omit=dev

EXPOSE 3000

CMD ["node", "dist/main.js"]
