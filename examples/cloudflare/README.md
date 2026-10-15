# example: cloudflare

A super-line node inside a Cloudflare **Durable Object**: sign-up and sign-in (`plugin-auth`), a live `#general`
channel (`plugin-chat`) and the Control Center channel (`plugin-inspector`), with every row on the object's own
SQLite. The page is plain TypeScript, served by the same Worker as static assets.

One Durable Object is one node. Its WebSockets **hibernate**: after about ten idle seconds the object leaves
memory while the sockets stay open, and the next message wakes a fresh instance that resumes every subscription
before it handles anything. The browser never notices.

## Run it locally

From the repo root, build the packages once (Vite and wrangler bundle their `dist`):

```bash
pnpm install
pnpm build
```

Then, from this directory:

```bash
pnpm dev        # vite build && wrangler dev → http://localhost:8787
```

Open the page in two windows, sign up as two people, and chat. To watch a wake, stay idle for 15 seconds, then
send: the terminal prints `node constructed` again — that line runs on first use and on every wake — and both
windows carry on without reconnecting.

## Deploy it

```bash
pnpm exec wrangler login
pnpm exec wrangler secret put SUPER_LINE_INSPECTOR_PASSWORD   # optional: guards the Control Center channel
pnpm run deploy                                               # vite build && wrangler deploy (`pnpm deploy` is pnpm's own command)
pnpm tail                                                     # live logs: one `node constructed` per wake
```

`wrangler deploy` prints the URL (`https://super-line-cloudflare-example.<your-subdomain>.workers.dev`). SQLite-backed
Durable Objects are available on the Workers Free plan.

## Inspect it

```bash
node ../../packages/control-center/bin/control-center.js --url wss://<your-worker-url>/ws
```

Sign in with user `admin` and the password you set. With no password set, the channel is open to anyone who can
reach the URL. While a Control Center watches the live feed, the node stays awake; close it and the node can
hibernate again.

## How it fits together

- **`wrangler.jsonc`** — one Durable Object class (`ChatNode`) declared with `new_sqlite_classes`, the
  `nodejs_compat` flag (the auth and inspector plugins use `node:crypto`), and `assets` pointing at `./dist`.
- **`src/worker.ts`** — `createDurableNode` turns the server factory into a Durable Object class; the Worker's
  `fetch` sends `/ws` to the one named object with `routeToNode` and answers anything else with a 404 itself,
  because every request the object receives wakes it. `cloudflareCollections(ctx.storage, …)` keeps users, sessions, channels and messages in the object's
  SQLite, so a wake reads them back from disk.
- **`src/web.ts`** — `authClient` and `chatClient` over `webSocketClientTransport`, dialing `/ws`. The client
  sets `keepalive`: the node runs no heartbeat (a timer would keep it awake forever), so the client pings
  instead, and Cloudflare answers those pings without waking the object.

## Things to know

- **The constructor runs on every wake.** Anything it does runs again, so keep it cheap and idempotent. Seeding
  `#general` here is one SQL read after the first boot; joining it tolerates an existing membership because a
  wake re-runs `onConnection` for every resumed socket.
- **Timers keep a node awake.** A pending `setTimeout` or `setInterval` blocks hibernation. A node running
  `plugin-queue` polls on an interval, so it never hibernates.
- **One object, one node.** `routeToNode` sends everyone to the same object by default; pass `name` to shard by
  tenant. Objects do not talk to each other.
