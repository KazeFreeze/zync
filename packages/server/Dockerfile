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
