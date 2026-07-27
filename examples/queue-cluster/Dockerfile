FROM node:24.14.0-bookworm-slim

RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

WORKDIR /app
COPY . .
RUN pnpm install --filter @super-line/example-queue-cluster... --frozen-lockfile

USER node
CMD ["./examples/queue-cluster/node_modules/.bin/tsx", "examples/queue-cluster/src/node.ts"]
