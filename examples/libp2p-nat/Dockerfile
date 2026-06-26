# Build context is the repo root (see docker-compose.yml) so the whole pnpm workspace is available.
# The relay and chat servers run straight off TypeScript via tsx — only deps need installing.
# NOTE: the chat servers use @libp2p/webrtc, which pulls in the native `node-datachannel` binding.
# pnpm builds it on install because `node-datachannel` is allow-listed in pnpm-workspace.yaml.
FROM node:24-slim
RUN corepack enable
WORKDIR /app
COPY . .
# Install only this example's subtree (skips unrelated native deps like store-sqlite's better-sqlite3).
RUN pnpm install --frozen-lockfile --filter "@super-line/example-libp2p-nat..."
# Default command is a chat server; the relay service overrides it in docker-compose.yml.
CMD ["pnpm", "--filter", "@super-line/example-libp2p-nat", "server"]
