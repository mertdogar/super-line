# @super-line/transport-cloudflare

Run a [**super-line**](https://super-line.dogar.biz/) server inside a Cloudflare **Durable Object**: one object is one node. Its WebSockets use the Hibernation API, so the object leaves memory between events while every socket stays open, and the next message wakes a fresh instance that resumes every subscription, open document, room, and `env` before it handles anything. The client never sees a disconnect.

```bash
pnpm add @super-line/core @super-line/server @super-line/transport-cloudflare
pnpm add -D wrangler @cloudflare/workers-types
```

The node must be a **SQLite-backed** class — the transport keeps each connection's snapshot in the object's SQLite:

```jsonc
// wrangler.jsonc
{
  "main": "./src/worker.ts",
  "compatibility_flags": ["nodejs_compat"], // only for plugin-auth / plugin-inspector
  "durable_objects": { "bindings": [{ "name": "NODE", "class_name": "Node" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Node"] }]
}
```

```ts
// src/worker.ts
import { createSuperLineServer } from '@super-line/server'
import { createDurableNode, routeToNode } from '@super-line/transport-cloudflare'
import { contract } from './contract'

interface Env {
  NODE: DurableObjectNamespace
}

// The factory runs on first use AND on every wake: keep it cheap and idempotent.
export class Node extends createDurableNode((ctx, env: Env, base) =>
  createSuperLineServer(contract, {
    ...base, // the Durable Object transport + a nodeKey stable for this object
    authenticate: (h) => ({ role: 'user', ctx: verify(h.query.token) }),
  }).implement({ user: { ping: async () => 'pong' } }),
) {}

export default {
  // Every request the object receives wakes it, so forward only the socket path.
  fetch: (request, env) =>
    new URL(request.url).pathname === '/ws'
      ? routeToNode(request, env.NODE)
      : new Response('Not found', { status: 404 }),
} satisfies ExportedHandler<Env>
```

Clients use the ordinary WebSocket client. The node runs no heartbeat (a timer would keep it awake), so set `keepalive` — Cloudflare answers those pings without waking the object:

```ts
import { webSocketClientTransport } from '@super-line/transport-websocket'

createSuperLineClient(contract, {
  transport: webSocketClientTransport({ url: 'wss://my-app.example.workers.dev/ws' }),
  role: 'user',
  keepalive: 30_000,
})
```

For durable state in the same object, pair it with [`@super-line/collections-cloudflare`](https://github.com/mertdogar/super-line/tree/main/packages/collections-cloudflare) (rows) and [`@super-line/collections-crdt-cloudflare`](https://github.com/mertdogar/super-line/tree/main/packages/collections-crdt-cloudflare) (CRDT documents).

## API

| Export | Meaning |
| --- | --- |
| `createDurableNode(build)` | A Durable Object class that is one node. `build(ctx, env, base)` returns the server built with `...base`; the class forwards `fetch` and the WebSocket handlers to the transport and resumes every surviving connection before any event is delivered. Exposes `this.server` and `this.transport`. |
| `routeToNode(request, namespace, { name? })` | Forward a Worker request to the node object — `'super-line'` by default; `name(request)` picks one object per tenant. |
| `cloudflareServerTransport(ctx)` | The transport itself, for a Durable Object class you write by hand: forward `fetch` / `webSocketMessage` / `webSocketClose` / `webSocketError`, and await `server.ready` inside `blockConcurrencyWhile`: on a wake it resolves once every surviving socket is back. |
| `CLOSE_NOT_RESUMABLE` | `4409` — closes a socket whose connection could not be resumed on wake; the client reconnects as after any drop. |

## Behavior notes

- **Handshake** — `transport: 'cloudflare'`, `query` from the URL, `headers` from the request, `raw` is the `Request`. An `authenticate` that throws `SuperLineError('UNAUTHORIZED')`, and a refused Control Center connection, are closed `4401` after the upgrade, so the client can tell them from an outage; any other throw gets a plain `401` and no socket.
- **What a wake loses** — everything in memory: `conn.data` (`onConnection` runs again for each resumed socket), memory collection backends, module state. Keep `ctx` and `env` JSON-serializable; the snapshot is stored as JSON.
- **A subscription can end with the socket open** — a wake runs each subscription's policy again, and one it now refuses reaches the client's `onError` with `kind: 'resubscribe'`.
- **Timers keep the node awake** — your own, `plugin-queue`'s polling (always), `plugin-inspector`'s keepalive (while a Control Center watches). A plugin's `ctx.hold()` keeps it awake on purpose.
- **One object, one node** — there is no adapter; objects don't share rooms, topics, or state.

- 📖 Guide: [Host a node on Cloudflare Durable Objects](https://super-line.dogar.biz/how-to/cloudflare-durable-objects)
- 🧪 Example: [`examples/cloudflare`](https://github.com/mertdogar/super-line/tree/main/examples/cloudflare)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
