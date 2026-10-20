# Build context is the repo root (see docker-compose.yml) so the whole pnpm workspace is available.
# No build step: the nodes run straight off TypeScript source via tsx, so only deps are installed.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# tsx directly, not through pnpm: pnpm doesn't forward SIGTERM, so `docker compose stop` would kill the node
# without its graceful close, and its presence entries would linger until the registry TTL.
CMD ["./examples/playground/node_modules/.bin/tsx", "examples/playground/src/server.ts"]
