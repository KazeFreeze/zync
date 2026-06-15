# Server image — runs the @zync/server relay (:1234) + blob HTTP endpoint
# (:8080). Mirrors packages/server/Dockerfile but built from the repo ROOT
# context (the compose `build.context` is the repo root) so it shares the
# workspace layout with the device image. Runs via tsx (NO compile step).
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @zync/server...
COPY packages/server packages/server

EXPOSE 1234
EXPOSE 8080
CMD ["pnpm","--filter","@zync/server","exec","tsx","src/index.ts"]
