# Build context is the repo root (see docker-compose.yml) so the whole pnpm workspace is
# available. No build step: the node runs straight off TypeScript source via tsx, so we
# only need deps installed.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@super-line/example-ai-canvas", "dev:server"]
