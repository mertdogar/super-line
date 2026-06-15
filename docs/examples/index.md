# Examples

Runnable examples live in [`examples/`](https://github.com/mertdogar/super-line/tree/main/examples). Clone the repo and `pnpm install` first.

- **chat** — a human (`user`) and an AI (`agent`) in the same room; shared `join` + `message`, role-specific verbs.
  `pnpm --filter @super-line/example-chat start`
- **react-chat** — browser React chat (Vite + WS server); open two tabs to chat live.
  `pnpm --filter @super-line/example-react-chat dev`
- **auth** — token auth with roles; admin-only `secret`, a user gets `NOT_FOUND`.
  `pnpm --filter @super-line/example-auth start`
- **scaling** — multi-node fan-out via Redis, including `serverToServer`. Needs Docker/Redis.
  `pnpm --filter @super-line/example-scaling start`
