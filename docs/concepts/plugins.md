# Plugins

A **plugin** is a named, declarative bundle you register on `plugins: [...]` — on the server, the client, or both as a **pair**, exactly like transports. It is the unit super-line uses to add a cross-cutting capability without forking anything, and it spans two halves: a **runtime half** (handlers, middleware, lifecycle, taps, channels, connections) and a **contract-time half** (collections, roles, and surface merged straight into the contract). One concept, two audiences:

- **App operators** who need observability — metrics, tracing, audit — bolted on without touching application code.
- **Library authors** who already export a [surface](/how-to/composition) and want to ship its handlers, middleware, and lifecycle as *one* mountable unit instead of five config sites.

Every field is optional. A plugin that only taps events is a single object; a full library plugin uses most of them. The step-by-step recipe for building one lives in [Building a plugin](/how-to/building-plugins) — this page is the model behind it.

## Paired, like transports

The server half and client half are independent objects that happen to share a name and ship together:

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

## The runtime half

The server plugin's shape is a bag of optional contributions, each of which multiplexes with the host and with other plugins:

```ts
interface SuperLinePlugin<S extends Directional = {}> {
  name: string                                          // unique; a duplicate throws at construction
  onEvent?: (event: TapEvent) => void                   // node-local tap — live refs, don't mutate
  use?: PluginMiddleware[]                               // after the host chain, in plugin order
  onConnection?: (conn, ctx) => void                    // multiplexed with the host's hook
  onDisconnect?: (conn, ctx, code) => void
  onError?: (error, info) => void
  handlers?: (ctx: PluginContext) => HandlersFor<S>      // compiled against the paired surface S
  setup?: (ctx: PluginContext) => void | (() => void)   // imperative wiring; dispose runs on close()
}
```

### Taps are node-local observers

`onEvent` fires synchronously at every emit site with **live** payload references — the same objects your handlers see, before any snapshot or redaction — reusing the inspector's `TapEvent` taxonomy (`msg.request`, `msg.response`, `connect`, `disconnect`, the `collection.*` / `crdt.*` families, …). It costs nothing when no plugin taps are registered. Two invariants make it safe to hand you a live reference:

- **Don't mutate.** You hold the real object, not a copy. Read it; never write it.
- **A throwing tap is isolated.** The error is routed to `onError` and the underlying operation still succeeds — a tap can never break traffic.

The tap sees only what happened on **this** node. A cluster-wide view is built by combining the tap with a plugin channel (below) — the same pattern the inspector itself uses.

### Middleware and lifecycle multiplex

The server's `use`, `onConnection`, `onDisconnect`, and `onError` were once singular — two concerns couldn't both register one. Plugins dissolve that: the host runs first, then each plugin in array order, every listener error-isolated. The two kinds of failure keep their distinct meaning — a throwing **middleware** rejects the operation (it's in the request path); a throwing **lifecycle hook** is isolated and routed to `onError` (its `info.kind` is `'connect'` / `'disconnect'`).

### Handlers compile against the paired surface

A library plugin ships alongside a [surface](/how-to/composition). Type the plugin with that surface and its `handlers` compile against it — the plugin *owns* those keys. This is where the two halves meet: see [the contract-time half](#the-contract-time-half) for why the host no longer has to implement them.

### Plugin-private cluster channels

`setup` runs once at construction with the plugin's `PluginContext` and may return a dispose function called on `server.close()` — use it for background wiring: timers, subscriptions, building a cluster-wide view from local taps. The `PluginContext` is the server's public surface minus the footguns (`implement`, `close`), plus one privileged capability — a plugin-private channel:

| | |
|---|---|
| `nodeId` · `nodeName` · `instanceId` | node identity |
| `serializer` · `contract` | the wire serializer and raw contract (for reflection) |
| `conns` · `local` · `cluster` | read-only connection views (node-local + cluster-wide) |
| `publish` · `subscribe` · `toConn` · `toUser` · `room` · `collection` · `isOnline` | the public server capabilities |
| `channel(name)` | a **plugin-private, cluster-wide** adapter channel under a reserved `x:<plugin>:` prefix |

`channel(name)` is how a plugin fans its own data across nodes without touching the app's contract — a private lane on the same [adapter](/concepts/transports-and-adapters) that carries application fan-out, with local echo filtered by comparing `meta.from` against `ctx.nodeId`.

### Persisted state

A plugin that needs durable state declares **collections** on its contract fragment (the contract-time half) — validated on every write like any other collection — and may contribute deny-by-default `policies`, merged into the server's. There is no separate plugin storage seam: a plugin's state is just collections that happen to belong to the plugin.

### Plugin-owned connections

A plugin can own its **own connection class** — a reserved role, negotiated by the transport, dispatched against the plugin's *own* fixed contract (never merged into the user's), and **observer-invisible** (excluded from `conns`, presence, the heartbeat, and user lifecycle hooks). This is how a plugin attaches a side-channel — a metrics scraper, an admin console, the Control Center — without polluting the app's roles or presence:

```ts
{
  name: 'admin',
  connection: {
    role: 'admin',                     // never one of the user contract's roles
    subprotocol: 'myapp.admin.v1',     // WS negotiates this; short-circuits authenticate
    contract: adminContract,           // its clientToServer = requests; subscribe topics = feeds
    handlers: (ctx) => ({
      'admin.stats': async () => gatherStats(),
    }),
  },
}
```

A reserved connection's **request** goes to `handlers`; a **subscribe** to one of its contract's topics is bridged to the plugin's [channel](#plugin-private-cluster-channels) of the same name — so anything the plugin publishes on `ctx.channel(topic)` streams to the attached clients, cluster-wide. The transport advertises the subprotocol **only** because the plugin declared it, so the server stays the single authority: no plugin, no handshake.

::: tip The inspector is exactly this
`@super-line/plugin-inspector` **is** a plugin: a tap that snapshots + redacts every event and publishes it on its `events` channel, plus a connection class (the `superline.inspector.v1` subprotocol) serving the Control Center the `InspectorContract`. `plugins: [inspector()]` is all it takes — see [Control Center](/how-to/control-center).
:::

## The contract-time half

ADR-0005's runtime boundary grew a compile-time counterpart: `defineContract({ plugins: [...] })` merges a plugin's collections, roles, and shared surface **into the contract** via a plain intersection (`ResolveContract`). The materialized contract is the single source of truth — `RowOf`, `client.collection`, and per-role `Requests` all infer from it with no type-threading, and callers that pass no plugins are untouched (`defineContract` is overloaded; the no-plugins path is identity).

The payoff is **compile-time handler subtraction**. Because the merged contract knows which keys a plugin owns, those keys are **subtracted from `implement()`'s obligation**:

```ts
import { defineSurface, mergeSurfaces } from '@super-line/core'

const api = defineContract({ roles: { user: mergeSurfaces(harnessSurface, appSurface) } })

const srv = createSuperLineServer(api, { transports, authenticate, plugins: [harness(cfg)] })
srv.implement({
  user: { say: async (t) => t },   // 'harness.join' is NOT required here — the plugin owns it
})
```

The type system holds both ends honest: forgetting the plugin (while its surface is merged) is a compile error — `implement` still requires the key; double-implementing it is a compile error too, backed by a runtime throw naming the key as the floor. Handling a key the contract never merged throws at construction ("did you forget to merge its surface?"). That is the sense in which **a plugin is a merge into the contract** — not a side-registry, but part of the one materialized definition both ends import. See [The contract](/concepts/the-contract).

::: tip Two full contract-fragment plugins ship today
[`@super-line/plugin-auth`](/how-to/plugin-auth) merges identity (users/sessions collections + `signIn`/`signUp`/… requests) and [`@super-line/plugin-chat`](/how-to/plugin-chat) merges a whole chat model (channels/memberships/messages collections + 11 mutation requests). plugin-chat is the reference for the **requests-first plugin idiom**: its collections are client-**read-only** (RLS `read`, `write` denied), and every mutation flows through a server-authoritative handler wrapped in a before/after **domain hook** a host can't bypass — the trade-off recorded in [ADR-0010](https://github.com/mertdogar/super-line/blob/main/docs/adr/0010-plugin-domain-surfaces-are-requests-first-with-domain-hooks.md).
:::

## The client half

The client plugin is smaller — it grows the client's first real lifecycle callbacks and lets a library answer its own server→client requests:

```ts
interface SuperLineClientPlugin {
  name: string
  onConnect?: () => void                 // first successful connect
  onDisconnect?: (code: number) => void  // socket dropped
  onReconnect?: () => void               // each reconnect after the first
  implement?: Record<string, (input) => unknown>  // answer the library's server→client requests
  onEvent?: (event: TapEvent) => void    // reserved; client taps are not instrumented yet
}
```

The matching `onConnect` / `onDisconnect` / `onReconnect` options live on the client directly too, alongside an `onError(error, info)` sink that catches a throw from any lifecycle hook (host or plugin; default logs to console). A client `implement` handler that collides with the app's `implement` or another plugin's throws, naming the key.

## Collisions never pass silently

Every contribution is checked for conflict, and a conflict is always a loud failure — never a silent last-writer-wins:

| Collision | Where it's caught |
|---|---|
| Duplicate plugin `name` | startup throw |
| Two plugins (or host + plugin) claim a handler key | compile error where the types reach; startup / `implement` throw naming the key otherwise |
| Client `implement` key registered twice | throw naming the key |

## What plugins deliberately don't do

Plugins **observe and contribute new operations** — they never transform or veto in-flight traffic. There is no outbound-message interception and no client `use` chain, because either would collide with super-line's **encode-once fan-out** and **echo-break** invariants: a message is serialized once and fanned to many, so there is no per-recipient rewrite seam to offer. Rate-limit and gate with server `use`; observe with `onEvent`; add capability with `handlers`, collections, and `channel`. The reasoning is in [ADR-0005](https://github.com/mertdogar/super-line/blob/main/docs/adr/0005-plugins-as-paired-runtime-bundles.md).

To build one hands-on — growing a single plugin from a tap into a full server + client pair — see [Building a plugin](/how-to/building-plugins). For the surface-merge discipline the contract-time half rests on, see [Composition](/how-to/composition).
