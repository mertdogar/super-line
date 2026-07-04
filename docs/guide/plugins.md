# Plugins

A **plugin** is a named, declarative bundle of runtime contributions you register on `plugins: [...]` — on the server, the client, or both as a **pair** (exactly like transports and stores). One concept serves two audiences:

- **App operators** who need cross-cutting observability — metrics, tracing, audit — without forking anything.
- **Library authors** who already export a [surface](./composition) and want to ship its handlers, stores, middleware, and lifecycle as *one* mountable unit instead of five config sites.

Every field is optional. A plugin that only taps events is one object; a full library plugin uses most of them.

```ts
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  plugins: [metrics(), harness({ historyLimit: 200 })],
})

const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url }),
  role: 'user',
  plugins: [harnessClient()],
})
```

## The server plugin

```ts
interface SuperLinePlugin<S extends Directional = {}> {
  name: string                                          // unique; a duplicate throws at construction
  onEvent?: (event: TapEvent) => void                   // node-local tap — live refs, don't mutate
  use?: PluginMiddleware[]                               // after the host chain, in plugin order
  onConnection?: (conn, ctx) => void                    // multiplexed with the host's hook
  onDisconnect?: (conn, ctx, code) => void
  onError?: (error, info) => void
  handlers?: (ctx: PluginContext) => HandlersFor<S>      // compiled against the paired surface S
  stores?: Record<string, ServerStore>                  // merged into srv.store(name)
  setup?: (ctx: PluginContext) => void | (() => void)   // imperative wiring; dispose runs on close()
}
```

### Taps — `onEvent`

The tap is a **node-local observer** fired synchronously at every emit site with **live** payload references — the same objects your handlers see, before any snapshot or redaction. It reuses the inspector's `TapEvent` taxonomy (`msg.request`, `msg.response`, `connect`, `store.write`, …). It costs nothing when no plugin taps are registered.

```ts
function metrics(): SuperLinePlugin {
  return {
    name: 'metrics',
    onEvent(e) {
      if (e.type === 'msg.request') counter.inc({ name: e.name, role: e.role })
      if (e.type === 'connect') gauge.inc()
      if (e.type === 'disconnect') gauge.dec()
    },
  }
}
```

Two rules:

- **Don't mutate** — you hold a live reference, not a copy. Read it; never write it.
- **A throwing tap is isolated** — the error is routed to `onError` and the underlying operation still succeeds. A tap can never break traffic.

The tap is *node-local*: it sees what happened on **this** node. To build a cluster-wide view, combine the tap with a plugin channel (below) — the same pattern the inspector uses.

### Middleware & lifecycle — multiplexed

The server's `use`, `onConnection`, `onDisconnect`, and `onError` were once singular — two concerns couldn't both register one. Plugins dissolve that: the host runs first, then each plugin in array order, every listener error-isolated.

```ts
{
  name: 'audit',
  use: [async (ctx, info, next) => { await next(); audit(info.name) }],
  onConnection: (conn) => log('joined', conn.id),
  onError: (err, info) => report(err, info),
}
```

A throwing **middleware** keeps its meaning — it rejects the operation. A throwing **lifecycle hook** is isolated and routed to `onError` (its `info.kind` is `'connect'`/`'disconnect'`).

### Handlers — the paired surface

A library plugin ships alongside a [surface](./composition). Type the plugin with that surface, and its `handlers` compile against it:

```ts
import { defineSurface } from '@super-line/core'

export const harnessSurface = defineSurface({
  clientToServer: { 'harness.join': { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) } },
  serverToClient: { 'harness.suspended': { payload: z.object({ id: z.string() }) } },
})

export function harness(cfg: HarnessConfig): SuperLinePlugin<typeof harnessSurface> {
  return {
    name: 'harness',
    handlers: (ctx) => ({
      'harness.join': async (input, _ctx, conn) => {
        ctx.room(`harness:${input.id}`).add(conn)
        return { ok: true }
      },
    }),
  }
}
```

The host still merges the surface explicitly (the contract types can only hang off `defineContract`) — but the plugin's keys are **subtracted from `implement()`'s obligation at compile time**:

```ts
const api = defineContract({ roles: { user: mergeSurfaces(harnessSurface, appSurface) } })

const srv = createSuperLineServer(api, { transports, authenticate, plugins: [harness(cfg)] })
srv.implement({
  user: { say: async (t) => t },   // 'harness.join' is NOT required here — the plugin owns it
})
```

Forgetting the plugin (while the surface is merged) is a compile error — `implement` still requires the key. Double-implementing it is a compile error too, and a runtime throw naming the key as the floor. Handling a key the contract never merged throws at construction ("did you forget to merge its surface?").

### Stores

Plugin stores merge into the host's store map and are reachable via `srv.store(name)` like any other. A name that collides with a host store — or another plugin's — throws at construction.

```ts
{ name: 'harness', stores: { 'harness.threads': memoryStoreServer() } }
```

### `setup` and the `PluginContext`

`setup` runs once at construction with the plugin's `PluginContext` and may return a dispose function, called on `server.close()`. Use it for background wiring — timers, subscriptions, or building a cluster-wide view from local taps.

The `PluginContext` is the server's public surface minus the footguns (`implement`, `close`), plus a privileged block:

| | |
|---|---|
| `nodeId` · `nodeName` · `instanceId` | node identity |
| `serializer` · `contract` | the wire serializer and raw contract (for reflection) |
| `conns` · `local` · `cluster` | read-only connection views (node-local + cluster-wide) |
| `publish` · `subscribe` · `toConn` · `toUser` · `room` · `store` · `isOnline` | the public server capabilities |
| `channel(name)` | a **plugin-private, cluster-wide** adapter channel under a reserved `x:<plugin>:` prefix |

`channel(name)` is how a plugin fans its own data across nodes without touching the contract:

```ts
{
  name: 'presence-ping',
  setup(ctx) {
    const ch = ctx.channel('pings')
    const off = ch.subscribe((data, meta) => {
      if (meta.from !== ctx.nodeId) record(data)   // ignore local echo
    })
    const timer = setInterval(() => ch.publish({ node: ctx.nodeName, at: Date.now() }), 5000)
    return () => { off(); clearInterval(timer) }    // disposed on server.close()
  },
}
```

## Plugin-owned connections

A plugin can own its **own connection class** — a reserved role, negotiated by the transport, dispatched against the plugin's *own* fixed contract (never merged into the user's), and **observer-invisible** (excluded from `conns`, presence, the heartbeat, and user lifecycle hooks). This is how a plugin attaches a side-channel — a metrics scraper, an admin console, or the Control Center — without polluting the app's roles or presence.

```ts
{
  name: 'admin',
  connection: {
    role: 'admin',                     // never one of the user contract's roles
    subprotocol: 'myapp.admin.v1',     // WS negotiates this; short-circuits authenticate
    contract: adminContract,           // its clientToServer = requests; subscribe topics = feeds
    handlers: (ctx) => ({
      'admin.stats': async () => ctx.storeInfos(),
    }),
  },
}
```

A reserved connection's **request** goes to `handlers`; a **subscribe** to one of the contract's topics is bridged to the plugin's [channel](#setup-and-the-plugincontext) of the same name — so anything the plugin publishes on `ctx.channel(topic)` streams to the attached clients, cluster-wide. The transport advertises the subprotocol **only** because the plugin declared it, so the server is the single authority (no plugin, no handshake).

::: tip The inspector is exactly this
`@super-line/plugin-inspector` **is** a plugin: a tap that snapshots + redacts every event and publishes it on its `events` channel, plus a connection class (the `superline.inspector.v1` subprotocol) serving the Control Center the `InspectorContract`. `plugins: [inspector()]` is all it takes — see [Control Center](./control-center).
:::

## The client plugin

The client half is smaller — it grows the client's first lifecycle callbacks:

```ts
interface SuperLineClientPlugin {
  name: string
  onConnect?: () => void                 // first successful connect
  onDisconnect?: (code: number) => void  // socket dropped
  onReconnect?: () => void               // each reconnect after the first
  stores?: Record<string, ClientStore>   // client halves, merged into client.store(name)
  implement?: Record<string, (input) => unknown>  // answer the library's server→client requests
  onEvent?: (event: TapEvent) => void    // reserved; client taps are not instrumented yet
}
```

The matching options live on the client too — `onConnect` / `onDisconnect` / `onReconnect`, plus a new `onError(error, info)` sink that catches a throw from any lifecycle hook (host or plugin; default logs to console). A client `implement` handler that collides with the app's `implement` or another plugin's throws, naming the key.

```ts
export function harnessClient(): SuperLineClientPlugin {
  return {
    name: 'harness',
    onReconnect: () => resyncHarnessState(),
    implement: { 'harness.suspended': async ({ id }) => acknowledge(id) },
  }
}
```

## Collisions never pass silently

| Collision | Where it's caught |
|---|---|
| Duplicate plugin `name` | startup throw |
| Two plugins (or host + plugin) claim a handler key | compile error where the types reach; startup/`implement` throw naming the key otherwise |
| Plugin store name vs a host or plugin store | startup throw naming the key |
| Client `implement` key registered twice | throw naming the key |

## What plugins don't do

Plugins **observe and contribute new operations** — they never transform or veto in-flight traffic. There's no outbound-message interception and no client `use` chain; that collides with super-line's encode-once fan-out and echo-break invariants. Rate-limit and gate with server `use`; observe with `onEvent`; add capability with `handlers`/`stores`/`channel`. The reasoning is in [ADR-0005](https://github.com/mertdogar/super-line/blob/main/docs/adr/0005-plugins-as-paired-runtime-bundles.md).

Next: [Building a plugin](./building-plugins) — a hands-on walkthrough that grows one plugin from a tap into a full server + client pair. Or [Composition](./composition) — the surface-merge discipline plugins build on.
