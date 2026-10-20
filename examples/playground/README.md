# playground — every headline feature on one stack

Two server nodes behind one round-robin entry point, with `plugin-auth`, `plugin-chat` and `plugin-queue`
on both, cluster presence over Redis, and the Control Center watching it all. One page, four panels,
so you can poke each feature and see the cluster react.

```
browser :8200 ── web (Caddy) ┬─ GET  /             → the SPA
                             ├─ WS   /ws           → round_robin  ┐
                             ├─ HTTP /superline/*  → cookie-sticky├→ node-1 / node-2
                             ├─ GET  /libp2p-addr  → round_robin  ┘  (then libp2p dials :9101 / :9102 directly)
                             ├─ ANY  /node-N/*     → node-N, prefix stripped (the header's node dial, ?node=)
                             └─ WS   /inspect      → node-1 (Control Center)
                                                   │            │
                         postgres + electric ──────┤  rows: users, sessions, channels, messages, queue jobs
                         redis ────────────────────┘  adapter: events, toUser(), stream deltas, presence registry
Control Center :8201 → ws://localhost:8200/inspect
```

## Run it

```bash
cd examples/playground
docker compose up --build
```

- Playground: <http://localhost:8200>
- Control Center: <http://localhost:8201>

Demo logins (`node-1` seeds them): `ada@example.com`, `grace@example.com`, `linus@example.com`, password `superline`.
Sessions are per tab, so open two tabs and sign in as two people. The header shows which node each tab landed on.

`docker compose down -v` stops it and wipes the database.

## What to try

| Feature | Try this | What it shows |
| --- | --- | --- |
| Multiple nodes | Pin one tab to `node-1` and another to `node-2` with the header's node dial (`?node=`) | Unpinned, Caddy balances each connection; everything below works across the two |
| Transports | Switch a tab's wire to HTTP (SSE) or libp2p (`?transport=`) | Same contract, plugins and UI on every wire; the Cluster box shows each connection's wire |
| Auth | Sign up, sign in, create and revoke an API key | `plugin-auth` sessions, roles, API keys; the Auth panel prints `useAuth().state` + `whoami` |
| Chat | Send a message in one tab, read it in the other | `plugin-chat` channels, memberships, messages as live collections |
| Chat streaming + queues | Send `/bot hello` | The `sendMessage.after` hook enqueues a `botReply` job; whichever node claims it streams the reply word by word |
| Presence | Watch the dots and the Cluster box as tabs open and close | `userPresence` rows (plugin-auth) and `srv.cluster.topology()` / `connections()` (Redis registry) |
| Targeted send | Click `nudge` next to a user on the other node | `srv.toUser(id).emit` reaches every device of that user, on any node |
| Queues | Enqueue `×10` at `30% fail` | Cluster-wide concurrency 2, retries with backoff, the `node` column shows who ran each job |
| Workers → you | Watch "Progress events" while your jobs run | The worker pushes `jobProgress` to the enqueuer with `toUser`, routed through Redis |
| Cron | Pause / resume / trigger `report-every-minute` | `plugin-queue` schedules, claimed once across the cluster |
| Control Center | Open :8201 | Topology of both nodes, the live wire feed, and the auth/chat/queue collections |

## Run it on Cloudflare (single node)

The same page on one Durable Object: auth, chat (including `/bot` streaming), presence and the Control Center
over the WebSocket transport, with every row in the object's own SQLite. There are no queues or cron, because a
polling queue keeps a Durable Object awake forever. There are also no extra nodes or wires: objects share
nothing, and Workers have no HTTP (SSE) or libp2p transport. The page hides the Queues panel and both dials.

From the repo root, build the packages once (wrangler bundles their `dist`):

```bash
pnpm install && pnpm build
```

Then, from this directory:

```bash
pnpm cf:dev               # vite build --mode cloudflare && wrangler dev → http://localhost:8787
pnpm cf:control-center    # second terminal: Control Center on http://localhost:8788
```

Stay idle for about 15 seconds, then send a message. The terminal prints `node constructed` again: the object
hibernated, woke for the message, and both tabs carried on without reconnecting.

Deploy with `pnpm exec wrangler login`, then `pnpm run cf:deploy`. Guard the Control Center channel first with
`pnpm exec wrangler secret put SUPER_LINE_INSPECTOR_PASSWORD`, and point a Control Center at it with
`node ../../packages/control-center/bin/control-center.js --url wss://<your-worker-url>/ws`.

What changes on Cloudflare:

- The Durable Object serves `base` (`src/contract-base.ts`: auth, chat, presence), and the browser keeps the full
  `app` contract. A queue request reaching the object would answer `NOT_FOUND`.
- `/bot` streams straight from the `sendMessage.after` hook instead of through a queue.
- The client sets `keepalive`: the object runs no heartbeat, so the client pings and Cloudflare answers without waking it.
- Presence counts an open session as online, because a hibernating object never refreshes `lastSeenAt`. The
  Cluster box refetches when `userPresence` changes instead of on a timer, because every request wakes the object.

## Files

- `src/contract.ts`: the merged contract (`authContract()` + `chatContract()` + `queueKit.contract`) plus the playground's own requests and events.
- `src/queue.ts`: the queues, declared without workers so the browser can import the contract.
- `src/contract-base.ts`: the queue-free contract the Durable Object serves; `contract.ts` adds the queues to it.
- `src/server.ts`: one Node node: three transports, plugins, workers (`setWorker`), introspection requests.
- `src/worker.ts` + `wrangler.jsonc`: the Durable Object node and its Worker.
- `src/workspace.ts`: seeding, welcome and the `/bot` stream, shared by both hosts.
- `src/dial.ts`: the tab's node + wire, read from `?node=` / `?transport=`.
- `src/panels/*`: one React panel per feature.

This example sits outside the root `pnpm typecheck` because it registers `Register`; check it with `pnpm --filter @super-line/example-playground typecheck`.
