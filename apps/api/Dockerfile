FROM oven/bun:1 AS dependencies

WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages packages

RUN bun install --frozen-lockfile


FROM oven/bun:1 AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package.json ./package.json
COPY --from=dependencies /app/bun.lock ./bun.lock
COPY --from=dependencies /app/turbo.json ./turbo.json
COPY --from=dependencies /app/apps/api/package.json ./apps/api/package.json
COPY --from=dependencies /app/apps/web/package.json ./apps/web/package.json
COPY --from=dependencies /app/packages ./packages

COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/prisma.config.ts
COPY apps/api/src apps/api/src

WORKDIR /app/apps/api
RUN bun run prisma:generate
EXPOSE 8095

CMD ["bun", "run", "src/server.ts"]