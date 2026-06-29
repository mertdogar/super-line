# Build context is the repo root (see docker-compose.yml) so the whole pnpm workspace is available.
# No build step: each node runs straight off TypeScript source via tsx. compose sets PORT / NODE_NAME / PG_URL
# / ELECTRIC_URL / AI_GATEWAY_API_KEY per service.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "@super-line/example-ai-canvas-pglite", "server"]
