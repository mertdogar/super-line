# Build context is the repo root (see docker-compose.yml) so the whole pnpm workspace is available.
# No build step: the lab runs straight off TypeScript source via tsx + tsconfig path mapping, which is
# also what lets compose bind-mount `src` directories for iteration without a rebuild.
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# compose overrides this per service (node / client / conductor).
CMD ["pnpm", "--filter", "@super-line/traffic-lab", "node"]
