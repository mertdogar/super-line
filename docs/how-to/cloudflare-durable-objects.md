# Host a node on Cloudflare Durable Objects

Run a super-line server inside a Cloudflare [Durable Object](https://developers.cloudflare.com/durable-objects/). One object is one node: it accepts WebSocket connections, runs your handlers and plugins, and keeps rows and CRDT documents in its own SQLite storage. Clients connect with the ordinary WebSocket client — nothing on the client side is Cloudflare-specific.

The object **hibernates** between events. After about ten idle seconds it leaves memory while every socket stays open; the next message wakes a fresh instance that resumes every connection before it handles anything. Subscriptions, open documents, rooms, and `env` all come back, and the client never sees a disconnect. [Hibernation & resumption](/concepts/hibernation) explains how, and what it costs.

Three packages, one per seam:

| Package | Seam | What it does |
| --- | --- | --- |
| [`@super-line/transport-cloudflare`](https://github.com/mertdogar/super-line/tree/main/packages/transport-cloudflare) | `transports:` | The Durable Object class helper, the Worker router, and the hibernation-aware WebSocket transport |
| [`@super-line/collections-cloudflare`](https://github.com/mertdogar/super-line/tree/main/packages/collections-cloudflare) | `collections:` | [Row collections](/collections/row-collections) in the object's SQLite, the same typed tables as `collections-sqlite` |
| [`@super-line/collections-crdt-cloudflare`](https://github.com/mertdogar/super-line/tree/main/packages/collections-crdt-cloudflare) | `crdtCollections:` | [CRDT documents](/collections/crdt-documents) in the object's SQLite, one row per document |

```bash
pnpm add @super-line/core @super-line/server @super-line/transport-cloudflare
pnpm add @super-line/collections-cloudflare                                      # row collections
pnpm add @super-line/collections-crdt-memory @super-line/collections-crdt-cloudflare  # CRDT documents
pnpm add -D wrangler @cloudflare/workers-types
```

::: tip A complete, deployable app
[`examples/cloudflare`](https://github.com/mertdogar/super-line/tree/main/examples/cloudflare) hosts sign-up, a live chat channel, and the Control Center channel in one Durable Object, with a plain-TypeScript page served as static assets. Its README walks `wrangler dev` and `wrangler deploy`.
:::

## Configure wrangler

The node must be a **SQLite-backed** Durable Object class: the transport stores each connection's snapshot in the object's SQLite, and so do both collection backends. Declare the class under `new_sqlite_classes` in a migration — SQLite-backed objects are available on the Workers Free plan.

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-10-01",
  // plugin-auth and plugin-inspector use node:crypto
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "NODE", "class_name": "Node" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Node"] }]
}
```

`nodejs_compat` is required when you run `plugin-auth` (password hashing, token comparison) or `plugin-inspector`. The core, server, and transport import no Node modules.

## Define the node

`createDurableNode` turns a server factory into a Durable Object class. Your factory receives the object's `ctx`, the Worker `env`, and a `base` to spread into the server options — it carries the Cloudflare transport and a `nodeKey` that is stable for the object. Call `createSuperLineServer` yourself, so the server keeps its full typing, and return it.

```ts
// src/worker.ts
import { createSuperLineServer } from '@super-line/server'
import { createDurableNode, routeToNode } from '@super-line/transport-cloudflare'
import { cloudflareCollections } from '@super-line/collections-cloudflare'
import { crdtCloudflareCollections } from '@super-line/collections-crdt-cloudflare'
import { contract } from './contract'

interface Env {
  NODE: DurableObjectNamespace
}

export class Node extends createDurableNode((ctx, env: Env, base) =>
  createSuperLineServer(contract, {
    ...base,
    authenticate: (h) => ({ role: 'user', ctx: verify(h.query.token) }),
    policies,
    collections: cloudflareCollections(ctx.storage, contract.collections),
    crdtCollections: crdtCloudflareCollections(ctx.storage, contract.collections),
  }).implement({ user: { ping: async () => 'pong' } }),
) {}

export default {
  fetch: (request, env) =>
    new URL(request.url).pathname === '/ws'
      ? routeToNode(request, env.NODE)
      : new Response('Not found', { status: 404 }),
} satisfies ExportedHandler<Env>
```

Export the class under the name your wrangler config binds. Inside it, `this.server` is the server your factory returned and `this.transport` is the transport.

`routeToNode` forwards a request to one named object — `'super-line'` unless you say otherwise. To give each tenant its own node, name the object per request:

```ts
routeToNode(request, env.NODE, { name: (req) => new URL(req.url).hostname })
```

Objects never talk to each other: there is no adapter, so rooms, topics, and the cluster event bus stay inside one object. A per-tenant object is a separate node with separate state.

::: warning Route only the socket path to the node
Every request a Durable Object receives wakes it. A stray `/favicon.ico` or a crawler hitting the root would construct the node for nothing, so the Worker forwards only the WebSocket path and answers everything else itself. Serve static files with Workers [static assets](https://developers.cloudflare.com/workers/static-assets/), which never reach the Worker's `fetch`.
:::

The handshake your `authenticate` receives is the usual [normalized `Handshake`](/how-to/choose-a-transport#write-auth-once): `transport` is `'cloudflare'`, `query` is the URL's query string, `headers` are the request headers, and `raw` is the `Request`. A thrown `SuperLineError('UNAUTHORIZED')` closes the socket 4401 right after the upgrade, so a browser can tell it from an outage and the client stops retrying; any other throw is a plain `401` before any socket opens.

## Connect a client

Use the [WebSocket client](/how-to/transport-websocket#client) against the socket path, and turn on `keepalive`:

```ts
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'

const client = createSuperLineClient(contract, {
  transport: webSocketClientTransport({ url: 'wss://my-app.example.workers.dev/ws' }),
  role: 'user',
  params: { token },
  keepalive: 30_000,
})
```

The server runs no heartbeat here, so `keepalive` is how a dead socket gets noticed: the client pings every N milliseconds and reconnects when nothing comes back before the next ping. Cloudflare answers those pings without waking the object. [Liveness moves to the transport](/concepts/hibernation#liveness-moves-to-the-transport) explains why.

## Run and deploy

Run locally with `wrangler dev`, then deploy:

```bash
pnpm exec wrangler dev       # http://localhost:8787
pnpm exec wrangler deploy
pnpm exec wrangler tail      # live logs from the deployed Worker and its objects
```

If you wrap the deploy in a `package.json` script named `deploy`, run it with `pnpm run deploy` — `pnpm deploy` is a built-in pnpm command.

A deploy restarts every object and closes its sockets. Clients reconnect through their ordinary [reconnect path](/concepts/reconnection-delivery) and re-subscribe, so a deploy looks like any brief outage.

## What a wake keeps, and what it loses

A woken node rebuilds each connection from a snapshot in the object's SQLite and replays its subscribes without answering the client — [A connection is rebuilt from its snapshot](/concepts/hibernation#a-connection-is-rebuilt-from-its-snapshot) walks the mechanism.

| Survives a wake | Lost on a wake |
| --- | --- |
| The socket itself | Everything in memory: module state, closures, caches |
| `ctx` and `env` | `conn.data` — `onConnection` runs again and can re-seed it |
| Topic subscriptions, collection subscriptions, open documents | Rows and documents in a memory backend |
| Rooms a handler joined | A timer that was pending when the object was evicted (none can be — a timer blocks hibernation) |
| Rows and documents in the Cloudflare backends | |

Two consequences for your code:

- **Keep `ctx` and `env` small and JSON-serializable.** A `Date` in `ctx` comes back as a string after a wake, and every subscribe rewrites the connection's snapshot, so a large `ctx` costs storage writes per connection.
- **Never rely on a memory backend.** `memoryCollections()` and `crdtMemoryCollections()` start empty on every wake, not only on a deploy. Use `cloudflareCollections` and `crdtCloudflareCollections`.

A socket whose snapshot is missing — rare, for example when a deploy raced a connect — is closed with code `4409` (`CLOSE_NOT_RESUMABLE`), and the client reconnects as it would after any drop.

### A subscription can end with the socket open

A wake runs each subscription's policy again, so a principal who lost access while the node slept loses that subscription with the socket still open. The client reports it on `onError` with `kind: 'resubscribe'`, naming the topic, the collection, or the collection and document id:

```ts
const client = createSuperLineClient(contract, {
  transport: webSocketClientTransport({ url }),
  role: 'user',
  keepalive: 30_000,
  onError: (error, info) => {
    if (info.kind === 'resubscribe') console.warn('subscription ended', info.topic ?? info.collection, error)
  },
})
```

Treat it exactly like a [failed re-subscribe after a reconnect](/concepts/reconnection-delivery#when-a-re-subscribe-fails): that subscription is dead until you subscribe again.

## Write the factory for re-runs

The factory you pass to `createDurableNode` is the object's constructor. It runs on first use **and on every wake**, and the server's `onConnection` hook runs again for every resumed socket. Keep both cheap and idempotent:

- **Seed inside `ctx.blockConcurrencyWhile`.** Work you start there finishes before any event reaches the object, so two first connections can't both create the same row.
- **Make `onConnection` side effects tolerate a repeat.** A "join the default channel" step must accept a membership that already exists.

```ts
export class Node extends createDurableNode((ctx, env: Env, base) => {
  const collections = cloudflareCollections(ctx.storage, contract.collections)
  const chatKit = chat({ contract })

  const server = createSuperLineServer(contract, {
    ...base,
    collections,
    // …
    onConnection: (_conn, connCtx) => void joinGeneral((connCtx as AuthContext).userId),
  })

  // finishes before any event reaches the object, so the channel is created exactly once
  const general = ctx.blockConcurrencyWhile(async () => {
    await server.ready
    const found = (await chatKit.channels.find()).find((c) => c.name === 'general')
    return (found ?? (await chatKit.channels.create({ name: 'general' }))).id
  })
  // runs again for every socket a wake resumes, so an existing membership is fine
  const joinGeneral = async (userId: string) => {
    const channelId = await general
    if (!(await chatKit.members.get(channelId, userId))) await chatKit.members.add(channelId, userId)
  }

  return server
}) {}
```

## What keeps a node awake

An object hibernates only when nothing is pending, and an awake node is billed for its duration. [An awake node is billed](/concepts/hibernation#an-awake-node-is-billed) explains the trade behind each row:

| Keeps the node awake | For how long |
| --- | --- |
| The server heartbeat | Never runs here — the transport owns liveness |
| Your own `setTimeout` / `setInterval` | Until it clears |
| `plugin-queue` | Always: it polls on an interval, so a node running queues never hibernates |
| `plugin-inspector` | Only while a Control Center watches the live feed |
| A `plugin-chat` streaming message | Until it settles (finalize or abort) |
| A CRDT document edit | 250 ms, until its write reaches storage |
| Any request the object receives | Until it's handled — hence routing only the socket path |

A plugin that holds in-memory work across events can keep the node awake the same way the chat plugin does, with `ctx.hold()` from its [`PluginContext`](/concepts/plugins#plugin-private-cluster-channels):

```ts
const release = ctx.hold()
try {
  await longRunningWork()
} finally {
  release()
}
```

A hold is a pending timer, not a guarantee: an object that receives no event for roughly 70–140 seconds is evicted even while held.

## Presence on a hibernating node

`plugin-auth`'s sessions and `userPresence` track who's connected here as on any host: a wake keeps the session of every socket it resumes, and a socket's close ends its session. A session whose socket didn't survive — after a deploy, for example — ends once the woken server is ready.

What changes is liveness: the server hears no heartbeat between events, so two readings change meaning:

- **`conn.lastPongAt`** never advances.
- **`lastSeenAt`** isn't refreshed while a session is open. It holds the time the session started, and the time of the close once the session ends.

The default online test — a `lastSeenAt` within the last 90 seconds — therefore marks every user offline 90 seconds after they connect. Read an open session as online instead. In the chat client, pass `presenceTimeoutMs: Infinity`, as a provider prop or to `chatClient`:

```tsx
<ChatProvider presenceTimeoutMs={Infinity}>{children}</ChatProvider>
// or: chatClient(client, { presenceTimeoutMs: Infinity })
```

Reading `userPresence` yourself, count a row as online while its `connectedAt` isn't `null`.

A client that vanishes without closing its socket — a laptop that sleeps, a network that drops — reads as online until Cloudflare reports that socket closed, and Cloudflare doesn't document how long that takes.

## Store rows and documents

Both backends take the object's `ctx.storage` and the contract's post-merge `collections` map, are synchronous, and open lazily on the first operation — building them in the constructor costs nothing and never throws. They declare `clustering: 'relay'`; with one node there is nothing to relay to.

The transport and the backends share the object's SQLite. They own these tables, so don't create tables with these names yourself:

| Table | Owner |
| --- | --- |
| `_sl_conn` | the transport — one connection snapshot per socket |
| `col_<name>` and `col_meta` | `cloudflareCollections` — one typed table per row collection, plus schema fingerprints |
| `_sl_crdt` | `crdtCloudflareCollections` — one row per document |

### Row collections

`cloudflareCollections` lays tables out exactly as [`collections-sqlite`](/collections/backends#typed-tables) does and compiles the same queries to SQL. Durable Object SQLite is stricter than a SQLite file in three ways:

| Limit | What happens |
| --- | --- |
| 98 typed columns per collection (the platform allows 100; two are row timestamps) | A wider collection fails its own operations with an `INTERNAL` error that names it. The rest of the object works. |
| 2 MB per row | The write fails, and the client receives `INTERNAL`. |
| 100 bound values per query | A snapshot whose filter needs more than 98 values (a long `in` list, for example) scans the table and filters in JavaScript. Results are the same; it's slower on a large table. |

### Change a schema on a deployed object

A deployed object keeps its tables across deploys, so a schema change meets the rows already stored. The backend compares each collection's schema with the fingerprint it stored when it created the table:

- **Additive changes apply automatically.** A new optional field becomes a new column on the first operation.
- **Anything else stops that collection.** A field that changed type, a removed field, or a new required field makes every operation on that collection fail with an `INTERNAL` error naming the collection and the fix. Other collections keep working, and the object stays up.

There are two ways forward:

1. **Rename the collection.** A new name gets a new table. The old table's rows stay in storage, unread.
2. **Migrate the table in code, before the store opens.** The store opens on its first operation, so run the migration with `ctx.storage.sql.exec` at the top of your factory, before you create the server. Dropping `col_<name>` and deleting its row from `col_meta` makes the backend recreate the table from the current schema; to keep the rows, copy them out first and write them back through `server.collection(name)` once the server is ready.

### CRDT documents

`crdtCloudflareCollections` keeps one row per document and merges with the same engine as `crdtMemoryCollections`, so `@super-line/collections-crdt-memory` is a peer dependency and clients use the usual [`crdtCollectionsClient()`](/collections/crdt-documents#client-open-a-document).

- **A document loads on first touch.** A wake reads nothing until a client or handler touches a document, so a node with thousands of documents wakes as fast as one with none.
- **Edits reach storage 250 ms later** (`debounceMs`). Hibernation never loses them — the pending write keeps the object awake until it lands. A deploy or a crash inside that window loses those edits.
- **A document is capped at 2 MB** of encoded state. `create` refuses a larger one, and an edit that grows a document past the cap is refused from then on with an `INTERNAL` error naming it; storage keeps the last state that fit. Split large content across several documents.

```ts
crdtCollections: crdtCloudflareCollections(ctx.storage, contract.collections, { debounceMs: 250 })
```

## Plugins

All four first-party plugins run in a Durable Object under `nodejs_compat`:

- **`plugin-auth`** needs a stable `nodeKey`, and `base` already carries one — the object's id. Password hashing runs in the object. Sessions survive a wake; read [Presence on a hibernating node](#presence-on-a-hibernating-node) before you show who's online.
- **`plugin-chat`** works unchanged. A streaming message keeps the node awake until it settles.
- **`plugin-queue`** works, but its polling interval means the node never hibernates.
- **`plugin-inspector`** accepts the Control Center on the same socket path: `npx @super-line/control-center --url wss://my-app.example.workers.dev/ws`. Each wake gives the node a new node id, so the Control Center shows a new id after a quiet spell; it's still the same object.

::: warning Use a long random inspector password
The Control Center sends its credentials in the URL query string. Cloudflare's logs redact query values heuristically — a long random password showed as `REDACTED` in testing, a short word in clear. Store it with `wrangler secret put` and generate it, for example with `openssl rand -hex 16`.
:::

## Write the Durable Object class yourself

`createDurableNode` covers most apps. When you need your own class — to add an `alarm()` handler or other RPC methods — extend the class it returns, or wire the transport by hand with `cloudflareServerTransport`:

```ts
import { DurableObject } from 'cloudflare:workers'
import { cloudflareServerTransport } from '@super-line/transport-cloudflare'

export class Node extends DurableObject<Env> {
  transport = cloudflareServerTransport(this.ctx)
  server = createSuperLineServer(contract, {
    transports: [this.transport],
    nodeKey: this.ctx.id.toString(),
    authenticate,
  })

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // `ready` resolves once every surviving socket is back; hold events until then
    void ctx.blockConcurrencyWhile(() => this.server.ready)
  }

  fetch(request: Request) {
    return this.transport.fetch(request)
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    this.transport.webSocketMessage(ws, message)
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.transport.webSocketClose(ws, code, reason)
  }
  webSocketError(ws: WebSocket, error: unknown) {
    this.transport.webSocketError(ws, error)
  }
}
```

On a wake, the server's `ready` resolves only after the transport has handed it every surviving socket and each socket's subscriptions are back. Await it inside `blockConcurrencyWhile`, so no message lands before then.

## Debug a deployed node

`wrangler tail` streams the Worker's and the object's logs, with two quirks:

- Hibernatable WebSocket events appear as `Unknown Event`.
- A log line attaches to the event that triggered it, so a line your constructor logs while accepting a WebSocket upgrade prints when that socket **closes**.

To watch a wake, log a line from your factory: it prints once on first use and again on each wake. super-line's own diagnostics go through [LogTape](/how-to/debugging-with-logs), under `['super-line', 'transport-cloudflare']` and `['super-line', 'collections-crdt-cloudflare']`.

## Limits at a glance

| Limit | Value |
| --- | --- |
| Nodes per deployment | One per object name; objects share nothing |
| Typed columns per row collection | 98 |
| Row size, document size | 2 MB |
| Filter values pushed to SQL | 98 (more scan in JavaScript) |
| Idle time before hibernation | about 10 seconds with nothing pending |
| Idle tolerance while a plugin holds the node | about 70–140 seconds without any event |
| CRDT edits lost on a deploy or crash | up to `debounceMs` (250 ms) |

## Next

- [Hibernation & resumption](/concepts/hibernation) — why a wake is invisible, and what the design gives up.
- [`examples/cloudflare`](https://github.com/mertdogar/super-line/tree/main/examples/cloudflare) — auth, chat, and the inspector in one Durable Object, ready to deploy.
- [Choose a transport](/how-to/choose-a-transport) — every wire super-line speaks.
- [Backends & clustering](/collections/backends) — how the Cloudflare backends compare with the others.
- [Reconnection & delivery](/concepts/reconnection-delivery) — what a reconnect restores, and the `keepalive` option.
