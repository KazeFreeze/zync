# Device image — runs the @zync/headless-client daemon (control API on :7070).
#
# Built from the repo ROOT context (the compose `build.context` is the repo
# root) so the full pnpm workspace is available. A full `pnpm install` is done
# in-image so the headless-client's workspace deps (@zync/core, @zync/crdt-yjs,
# @zync/blob-http) and tsx are all resolvable; the daemon is run via tsx (NO compile step).
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# Workspace manifests first so the install layer caches across source changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/crdt-yjs/package.json packages/crdt-yjs/
COPY packages/blob-http/package.json packages/blob-http/
COPY packages/server/package.json packages/server/
COPY packages/headless-client/package.json packages/headless-client/

# The headless-client needs core + crdt-yjs + blob-http + server(devDep) + tsx.
# Installing that filtered closure keeps the image lean while pulling everything
# tsx needs to run the daemon end-to-end.
RUN pnpm install --frozen-lockfile --filter @zync/headless-client...

# Now the sources (these layers change often; kept after the install layer).
COPY packages/core packages/core
COPY packages/crdt-yjs packages/crdt-yjs
COPY packages/blob-http packages/blob-http
COPY packages/server packages/server
COPY packages/headless-client packages/headless-client

EXPOSE 7070
CMD ["pnpm","--filter","@zync/headless-client","exec","tsx","src/daemon.ts"]
