---
id: T11
title: Build examples/cloudflare and deploy it
labels: [wayfinder:task]
status: closed
assignee: claude session 2026-10-15 (T11)
closed: 2026-10-15
blocked-by: [T07,T09,T10]
---

## Question

A real `examples/cloudflare`: Worker + DO class hosting a super-line server with auth + chat (or collections) + inspector, wrangler config with `nodejs_compat` and `new_sqlite_classes`, a browser client that connects over the new transport, a README that walks `wrangler dev` and `wrangler deploy`. Prove it deployed to a real account at least once (hibernation observed via the dashboard or logs); record the URL shape and gotchas in the resolution. Ask the user before any deploy that costs money.

> From T10: local workerd enforces NO 2 MB row limit, so the rows backend's over-2-MB error (it relies on the platform's) is only observable on the real deploy — confirm it there and record the message. CRDT docs refuse >2 MB themselves. A CRDT edit is written through 250 ms later; a deploy inside that window loses it — worth one line in the example README.

## Resolution

**Built and deployed once.** `examples/cloudflare`: one `ChatNode` Durable Object hosting auth + chat + inspector, rows on
`cloudflareCollections(ctx.storage, …)`; a vanilla-TS page (Vite → `dist`, served as Workers static assets) using
`authClient` + `chatClient` over `webSocketClientTransport` to `/ws` with `keepalive: 30_000`; `wrangler.jsonc` with
`nodejs_compat`, `new_sqlite_classes`, `observability`; README walks `pnpm dev` (`vite build && wrangler dev`) and
`pnpm run deploy`. Example worker file is typechecked by its own tsconfig inside `pnpm typecheck`; the browser half stays
in the root project (Workers' global `Element` collides with the DOM's).

**Found and fixed: plugin-inspector kept every node awake.** Its watcher keepalive was an unconditional 2 s
`setInterval` from `setup`, so a node with the inspector could never hibernate (T05's "Control Center needs nothing
special" missed it; T07's hibernation tests ran with no plugins). The timer now runs only while a Control Center watches,
locally or on a peer. Regression test in `packages/server/test/inspector.integration.test.ts` (mutation-checked: the old
code fails `expected 1 to be +0`). Measured under `wrangler dev`: old inspector, an idle session never re-constructed the
node; fixed, it hibernates and the next message wakes a new instance with no reconnect. **plugin-inspector owes a patch
release (T13).** Skills REFERENCE updated (inspector holds the node only while watched; route only the socket path).

**Deployed** to `https://super-line-cloudflare-example.<account-subdomain>.workers.dev` (Worker 1.47 MB / 245 KB gzip,
42 ms startup), verified, then **deleted** on the user's call:
- two users signed up (scrypt under `nodejs_compat`; ~0.4–0.6 s wall incl. network, no CPU-limit event — account plan
  not checked), auto-joined `#general`, chatted live;
- **hibernation observed for real**: idle 20 s mid-session → the next message constructed a new instance (`wrangler tail`
  `node constructed` count 1 → 2, and 3 → 5 on the second run) and delivery carried on with zero client lifecycle events;
- inspector reachable on `wss://…/ws` with the secret password; a wrong one closes `4401 invalid inspector credentials`.
  Its reserved connection also survives a wake (`wrangler dev`).

Gotchas recorded (for T12's how-to):
- **Every request a DO receives wakes it**: the first deploy's node was constructed by a stray `/favicon.ico`. The Worker
  now forwards only `/ws` and 404s the rest itself.
- `pnpm deploy` is pnpm's own command → `pnpm run deploy`.
- The constructor runs on every wake, and a wake re-runs `onConnection` for each adopted socket → seeding goes in the
  host's own `blockConcurrencyWhile` (it runs before the resume one) and joins await that promise.
- `wrangler tail` shows hibernatable WebSocket events as `Unknown Event`; a log line attaches to its triggering event,
  so a constructor log on a WebSocket upgrade prints when that socket *closes*.
- Log redaction of query strings is heuristic: the 32-hex inspector password and `token` printed `REDACTED`, `nope` in
  clear. The Control Center's credentials ride the query string → strong passwords only.
- `nodeId` is per construction, so each wake shows a new node id in the Control Center (cosmetic on one node).
- Presence `online` relies on `lastSeenAt`, which nothing refreshes without the server heartbeat → the example shows no
  online state (already a T12 docs item).

**Not done**: T10's request to record the platform's over-2 MB row error text on a real deploy — missed before the delete.
The server masks it to `INTERNAL` either way, so it only matters for server logs; carried to T12. The CRDT 250 ms-window
README line doesn't apply (the example has no CRDT collection); REFERENCE already states it.

Lanes: fast 855/855, integration 158 passed (6 skipped), workers 69/69; `pnpm typecheck` + `pnpm lint` clean.
