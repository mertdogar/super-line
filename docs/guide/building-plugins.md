# Building a plugin

This is the hands-on companion to [Plugins](./plugins) (the reference). We'll start from an empty object and grow it — one capability at a time — into a full server + client **pair** you could publish as `@you/plugin-activity`.

The running example is an **activity** plugin: it counts requests per role, aggregates the counts across a cluster, and exposes the totals through the contract. Every super-line plugin capability shows up along the way. Each step is runnable on its own — stop at whichever rung covers your need.

## 1 · The smallest plugin is a tap

A plugin is a plain object. The only required field is `name`. The cheapest useful field is `onEvent` — a **node-local tap** fired synchronously at every emit site (requests, responses, connects, store writes…) with the `TapEvent` taxonomy.

```ts
// activity.ts
import type { SuperLinePlugin } from '@super-line/server'

export function activity(): SuperLinePlugin {
  const requests = new Map<string, number>()   // role -> count

  return {
    name: 'activity',
    onEvent(e) {
      if (e.type === 'msg.request') {
        requests.set(e.role, (requests.get(e.role) ?? 0) + 1)
      }
    },
  }
}
```

Register it on the server — nothing else changes:

```ts
import { activity } from './activity'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  plugins: [activity()],
})
```

That's a complete plugin. Two rules govern the tap:

- **The payload is a live reference, not a copy** — read it, never mutate it. Mutating it corrupts the real traffic your handlers see.
- **A throwing tap is isolated** — the error is routed to `onError` and the underlying request still succeeds. A tap can never break traffic.

The tap costs nothing when no plugin registers one. It is *node-local*: it only sees what happened on **this** process. Step 3 fixes that.

::: tip Which events fire?
`TapEvent` is the inspector's taxonomy — `msg.request` / `msg.response` / `msg.event` / `msg.broadcast` / `msg.publish`, `connect` / `disconnect`, `room.add` / `room.remove`, `topic.sub` / `topic.unsub`, `store.write` / `store.delete`, plus the node-to-node `msg.serverRequest` / `msg.serverReply`. Narrow on `e.type` and the rest of the fields type-narrow with it.
:::

## 2 · Add middleware & lifecycle

The server's `use`, `onConnection`, `onDisconnect`, and `onError` used to be singular — one function each, so two concerns couldn't share them. A plugin multiplexes into all of them: the host runs first, then every plugin in array order, each listener error-isolated.

```ts
return {
  name: 'activity',
  onEvent(e) { /* … */ },

  onConnection: (conn) => console.log('joined', conn.id),
  onDisconnect: (conn, _ctx, code) => console.log('left', conn.id, code),

  use: [
    async (ctx, info, next) => {
      const t = performance.now()
      await next()                              // run the real handler
      console.log(info.name, `${(performance.now() - t).toFixed(1)}ms`)
    },
  ],
}
```

A throwing **middleware** keeps its meaning — it rejects the operation (return a `SuperLineError` code to shape the wire error). A throwing **lifecycle hook** is isolated and routed to `onError`. Middleware is the only interception seam a plugin gets — see [what plugins don't do](./plugins#what-plugins-don-t-do).

## 3 · Aggregate across the cluster with `setup` + a channel

The tap is node-local, so a two-node cluster has two half-counts. To build a cluster-wide view, pair the tap with a **plugin channel** — a private, cluster-wide pub/sub lane under a reserved `x:<plugin>:` prefix, fanned out over whatever [adapter](./scaling-adapters) you run. Wire it in `setup`, which runs once at construction with the [`PluginContext`](./plugins#setup-and-the-plugincontext) and may return a dispose function called on `server.close()`.

```ts
export function activity(): SuperLinePlugin {
  const local = new Map<string, number>()          // this node's counts
  const cluster = new Map<string, Map<string, number>>()  // nodeId -> counts

  return {
    name: 'activity',
    onEvent(e) {
      if (e.type === 'msg.request') local.set(e.role, (local.get(e.role) ?? 0) + 1)
    },
    setup(ctx) {
      const ch = ctx.channel('counts')
      // publish our local tallies every few seconds
      const timer = setInterval(() => ch.publish({ node: ctx.nodeId, counts: [...local] }), 3000)
      // absorb every node's tallies (including our own echo)
      const off = ch.subscribe((data: any) => cluster.set(data.node, new Map(data.counts)))
      return () => { clearInterval(timer); off() }   // disposed on server.close()
    },
  }
}
```

`cluster` now holds a live, cluster-wide picture. Notice we didn't touch the contract, add a role, or require an app to configure anything — the channel is the plugin's own private lane.

## 4 · Expose it through the contract — the paired surface

To let clients *ask* for the totals, the plugin needs a request in the contract. A plugin can't inject typed surface on its own (the contract types can only hang off `defineContract`), so it ships a [**surface fragment**](./composition) the host merges — and in return, its handler keys are **subtracted from `implement()`'s obligation at compile time**.

```ts
import { defineSurface } from '@super-line/core'
import type { SuperLinePlugin } from '@super-line/server'
import { z } from 'zod'

export const activitySurface = defineSurface({
  clientToServer: {
    'activity.totals': { input: z.object({}), output: z.record(z.string(), z.number()) },
  },
})

export function activity(): SuperLinePlugin<typeof activitySurface> {
  const cluster = new Map<string, Map<string, number>>()
  // …onEvent + setup exactly as in step 3, filling `cluster`…

  return {
    name: 'activity',
    // onEvent, setup: …
    handlers: (ctx) => ({
      'activity.totals': async () => {
        const totals: Record<string, number> = {}
        for (const counts of cluster.values())
          for (const [role, n] of counts) totals[role] = (totals[role] ?? 0) + n
        return totals
      },
    }),
  }
}
```

The host merges the fragment into a role, and `implement()` no longer requires `activity.totals`:

```ts
import { mergeSurfaces } from '@super-line/core'
import { activity, activitySurface } from './activity'

const api = defineContract({
  roles: { user: mergeSurfaces(appSurface, activitySurface) },
})

const srv = createSuperLineServer(api, { transports, authenticate, plugins: [activity()] })

srv.implement({
  user: {
    say: async (t) => t,          // your own handlers
    // 'activity.totals' is NOT required here — the plugin owns it
  },
})
```

The type system enforces the pairing both ways: merge the surface but forget the plugin and `implement` still demands the key (compile error); implement it *and* mount the plugin and you get a compile error plus a runtime throw naming the key. Handling a key the contract never merged throws at construction — *"did you forget to merge its surface?"*.

## 5 · Ship the client half

A plugin ships as a **pair** — a `SuperLinePlugin` for the server, an optional `SuperLineClientPlugin` for the client (same idea as transports and stores). The client half is smaller: it grows the client's first lifecycle callbacks and can answer the library's server→client requests.

```ts
// activity.client.ts
import type { SuperLineClientPlugin } from '@super-line/client'

export function activityClient(): SuperLineClientPlugin {
  return {
    name: 'activity',
    onConnect: () => console.log('activity: connected'),
    onReconnect: () => console.log('activity: resynced after a drop'),
    onDisconnect: (code) => console.log('activity: dropped', code),
    // implement: { 'activity.push': async (p) => { … } },  // if the surface had a serverToClient request
  }
}
```

```ts
const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url }),
  role: 'user',
  plugins: [activityClient()],
})

const totals = await client['activity.totals']({})   // the paired request, fully typed
```

The matching bare options live on the client too — `onConnect` / `onDisconnect` / `onReconnect`, plus a new `onError(error, info)` sink that catches any throw from a lifecycle hook (host or plugin; it logs to console by default). These are the client's **first** lifecycle hooks — before plugins, a reconnect was unobservable.

## 6 · Optional: contribute a collection

If the plugin needs durable, typed state, contribute a [collection](./collections) on the **contract** via a
contract-fragment plugin, and lock it down with server-side `policies`. The fragment merges into the host's
contract (so `RowOf` / `client.collection(name)` infer it end-to-end), and the collection is reachable as
`srv.collection(name)` / `client.collection(name)` like any other — deny-by-default until the plugin's policy
opens it. This is the `@super-line/plugin-auth` shape in miniature.

```ts
import { defineContractPlugin } from '@super-line/core'
import { z } from 'zod'

// contract-time half: declare the collection (merges into the host contract)
export const activityContract = () =>
  defineContractPlugin('activity', {
    collections: { 'activity.daily': { schema: z.object({ id: z.string(), count: z.number() }), key: 'id' } },
  })

// server-time half: own its access — deny-by-default, so the host can't accidentally expose it
export const activityPlugin: SuperLinePlugin = {
  name: 'activity',
  policies: { 'activity.daily': { read: () => undefined, write: (principal) => principal === 'system' } },
  setup(ctx) {
    // ctx.server.collection('activity.daily').insert(...) — roll the day's totals on a timer…
  },
}
```

A collection name that collides with a host collection — or another plugin's — throws at construction.

## 7 · Optional: a plugin-owned connection

The deepest seam: a plugin can own its **own connection class** — a reserved role the transport negotiates, dispatched against the plugin's *own* fixed contract (never merged into the app's), and **observer-invisible** (excluded from `conns`, presence, the heartbeat, and user lifecycle hooks). This is how a plugin attaches a side-channel — an admin console, a metrics scraper, or a live dashboard — without polluting the app's roles or presence.

```ts
import { defineContract } from '@super-line/core'

const dashContract = defineContract({
  roles: {
    dash: {
      clientToServer: { 'dash.totals': { input: z.object({}), output: z.record(z.string(), z.number()) } },
      subscribe: { updates: { payload: z.record(z.string(), z.number()) } },   // a feed
    },
  },
})

return {
  name: 'activity',
  connection: {
    role: 'dash',                      // never one of the user contract's roles
    subprotocol: 'activity.dash.v1',   // the WS negotiates this; it short-circuits authenticate
    contract: dashContract,
    handlers: (ctx) => ({
      'dash.totals': async () => currentTotals(),
    }),
  },
  setup(ctx) {
    // push live updates: a subscribe to the `updates` topic bridges to this channel
    const timer = setInterval(() => ctx.channel('updates').publish(currentTotals()), 1000)
    return () => clearInterval(timer)
  },
}
```

A reserved connection's **request** goes to its `handlers`; a **subscribe** to one of its contract's topics is bridged to the plugin's `ctx.channel(name)` of the same name — so anything the plugin publishes there streams to attached clients, cluster-wide, wire-identical. The transport advertises the subprotocol **only** because the plugin declared it, so the server stays the single authority.

This is exactly what [`@super-line/plugin-inspector`](./control-center) is: a tap that snapshots + redacts every event and publishes it on its `events` channel, plus a connection class (the `superline.inspector.v1` subprotocol) that serves the Control Center. If you want a complete, real reference, read that package's `src/index.ts`.

## 8 · Test your plugin

Boot a real loopback server and drive it with a real client — you exercise the actual handshake, frames, and validation. No plugin-specific harness needed.

```ts
import { afterEach, expect, test } from 'vitest'
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { activity, activitySurface } from '../src/activity'

test('activity.totals counts requests', async () => {
  const api = defineContract({ roles: { user: mergeSurfaces(appSurface, activitySurface) } })
  const httpServer = http.createServer()
  const srv = createSuperLineServer(api, {
    transports: [webSocketServerTransport({ server: httpServer })],
    authenticate: () => ({ role: 'user', ctx: {} }),
    plugins: [activity()],
  })
  srv.implement({ user: { say: async (t) => t } })
  await new Promise<void>((r) => httpServer.listen(0, r))
  const { port } = httpServer.address() as import('node:net').AddressInfo

  const client = createSuperLineClient(api, {
    transport: webSocketClientTransport({ url: `ws://localhost:${port}` }),
    role: 'user',
    plugins: [/* activityClient() */],
  })
  await client.say({ text: 'hi' })
  const totals = await client['activity.totals']({})
  expect(totals.user).toBeGreaterThan(0)

  await client.close(); await srv.close(); httpServer.close()
})
```

## 9 · Package & publish

A plugin is just a package that exports the two factories. Mirror the conventions the built-in plugins use:

```
plugin-activity/
├─ package.json          # name: "@you/plugin-activity", type: "module"
├─ tsup.config.ts        # external: core, server, client — never bundle them
└─ src/
   ├─ index.ts           # export { activity, activityClient, activitySurface }
   ├─ activity.ts        # the server half (SuperLinePlugin)
   └─ activity.client.ts # the client half (SuperLineClientPlugin)
```

- Depend on `@super-line/core`; keep `@super-line/server` and `@super-line/client` as **peer** dependencies (the app owns their versions), mirrored into `devDependencies` for your own build. Mark them `external` in tsup so they're never bundled.
- Export the **surface fragment** alongside the factories so hosts can `mergeSurfaces` it.
- Namespace your contributions — handler keys (`activity.*`), store names (`activity.*`), and channel names — so they never collide with an app's. The `x:<plugin>:` channel prefix is applied for you; the rest is convention.

Every collision is caught, never silent:

| Collision | Where |
|---|---|
| Duplicate plugin `name` | startup throw |
| Two plugins (or host + plugin) claim a handler key | compile error where types reach; else startup / `implement` throw naming the key |
| Plugin store name vs a host or plugin store | startup throw |
| Client `implement` key registered twice | throw naming the key |

## Where to go next

- [Plugins](./plugins) — the full reference: every field, the `PluginContext` table, and what plugins deliberately don't do.
- [Composition](./composition) — the `defineSurface` / `mergeSurfaces` discipline your paired surface builds on.
- [ADR-0005](https://github.com/mertdogar/super-line/blob/main/docs/adr/0005-plugins-as-paired-runtime-bundles.md) — why plugins are paired runtime bundles, and why there's no outbound interception.
