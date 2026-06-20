# Build context is the repo root (see docker-compose.yml) so the whole pnpm workspace is
# available. No build step: the example runs straight off TypeScript source via tsx + tsconfig
# path mapping, so we only need deps installed. `zeromq` is a native addon — pnpm fetches its
# prebuilt binary for the image's platform during install (no compiler toolchain needed).
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# compose overrides this per service (server vs client); default keeps the image runnable alone.
CMD ["pnpm", "--filter", "@super-line/example-scaling-zeromq", "server"]
