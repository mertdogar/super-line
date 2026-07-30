<script setup>
import MultiNodeDemo from '../.vitepress/theme/components/demos/MultiNodeDemo.vue'
</script>

# Tutorial 7 · Go multi-node

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <a href="/tutorials/collaborate-with-crdt">6 · Collaborate on one document</a> → <strong>7 · Go multi-node</strong></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
One node has a ceiling. super-line's answer is the <strong>adapter</strong>: a tiny server↔server fan-out seam that carries rooms, topics, and the cluster event bus across every node — while <em>none</em> of your contract, handlers, policies, or clients change. In this lesson you meet the seam by reading a complete adapter (it fits on this page), run a real two-node cluster <strong>in this tab</strong>, and learn the one line that swaps it for Redis.
</p>

<p class="sl-qs-meta">
  <span>~7 minutes</span>
  <span>Builds on Tutorial 2</span>
  <span>TypeScript · zero codegen</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Fan out</b> <code>adapter</code></span>
  <span class="sl-qs-pill"><b>Bus</b> <code>srv.publish</code> / <code>srv.subscribe</code></span>
  <span class="sl-qs-pill"><b>Sever</b> it, live</span>
</p>

</div>

## First, sever a cluster

Two **real server nodes**, each a full `createSuperLineServer` with two subscribed clients, joined by one adapter bus. React on any client: it reaches that node's other client *and* crosses the bus to the far node. Now **sever the bus** — cross-node delivery stops dead, while each node keeps serving its own clients. Reconnect and the cluster heals.

<MultiNodeDemo />

This is the vocabulary triangle from [Tutorial 4](/tutorials/store-your-data), completed: **transports** carry client↔server bytes, **backends** store collection rows, and **adapters** carry node↔node fan-out.

## 1. Read a whole adapter

The demo's bus isn't a special demo mode — it's an ordinary implementation of core's `Adapter` interface, the same seam `@super-line/adapter-redis` and `-libp2p` implement. Here is its entire source, exactly as the demo above runs it:

<<< @/.vitepress/theme/components/demos/demo-bus.ts

Four methods: `subscribe`/`unsubscribe` a channel, `publish` a payload, `onMessage` to receive. Rooms, topics, and the event bus all compile down to channel pub/sub on this seam. A node subscribes to a channel only while it has a local member, and every publish goes through the adapter — which is why severing `SeverableBus` kills cross-node delivery *and nothing else*.

## 2. Give each node the adapter

Each node in the demo is your Tutorial 1 server plus **one option**:

```ts
const srv = createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server })],
  adapter: new DemoAdapter(bus), // ← the whole clustering story is this line
  authenticate: /* … */,
})
```

Every node runs the same code — same contract, same `implement`, same policies. A client can connect to *any* node (put a load balancer in front); a `srv.room(...).broadcast` or `srv.publish` on one node reaches subscribers on all of them.

## 3. In production: Redis

Swap the in-page bus for a broker and you have the classic deployment shape:

::: code-group

```bash [pnpm]
pnpm add @super-line/adapter-redis
```

```bash [npm]
npm install @super-line/adapter-redis
```

:::

```ts
import { createRedisAdapter } from '@super-line/adapter-redis'

  adapter: new DemoAdapter(bus), // [!code --]
  adapter: createRedisAdapter('redis://localhost:6379'), // [!code ++]
```

Run two copies of your server on different ports behind that one Redis and you've reproduced the demo — for real processes. Prefer broker-less? [libp2p](/how-to/adapter-libp2p) gossips peer-to-peer; [RabbitMQ](/how-to/adapter-rabbitmq) and [ZeroMQ](/how-to/adapter-zeromq) also ship. [Choose an adapter](/how-to/choose-an-adapter) compares them.

## 4. Servers talking to servers

The adapter also powers the **cluster event bus** — server-side pub/sub over the same shared topics, with local echo. That's how nodes coordinate work (cache invalidation, job signals, presence aggregation) without a side-channel:

```ts
// any node — publish reaches every node's subscribers, clients and servers alike
srv.publish('presence', { room: 'lobby', count: srv.room('lobby').size })

// server-side subscription: fires for a publish from ANY node, including this one
const off = srv.subscribe('presence', (data, meta) => {
  if (meta.from === srv.nodeId) return // self-exclude if you only want remote publishes
  console.log(`node ${meta.from} says ${data.room} has ${data.count}`)
})
```

And your data layer? [Collection](/tutorials/store-your-data) writes relay across nodes through the same adapter — while the `self`-clustering Postgres tier (`collections-pglite`) gives every node a synced replica of a central database and doesn't need the adapter for row sync at all. See [Backends & clustering](/collections/backends).

<div class="sl-result">
  <p class="sl-result__h">That's the whole path, zero to cluster.</p>
  <p>A contract that types everything on the wire · a server that validates and authorizes all of it · clients and React hooks inferred from the same file · collections with row-level security on swappable storage · auth and chat as mergeable plugins · documents that merge under concurrent edits · and now N nodes behind one adapter seam — <strong>with the app code unchanged</strong>.</p>
</div>

## What just happened

| Piece | What it does |
| --- | --- |
| `Adapter` (4 methods) | The entire server↔server seam: channel pub/sub. You read a full implementation above. |
| `adapter: …` server option | Joins the node to the cluster. Everything else is unchanged. |
| `srv.publish` / `srv.subscribe` | The cluster event bus — shared topics, cluster-wide, with local echo and `meta.from`. |
| Redis / libp2p / RabbitMQ / ZeroMQ | Production adapters behind the same interface as the demo's 50-line bus. |

## Where to next

You've finished the path. Three deeper builds continue it, each on top of what you just made:

- **[Put a live AI agent in the chat](/tutorials/ai-agent-chat)** — the Tutorial 5 chat, plus an LLM participant streaming its answers.
- **[Co-edit a canvas with an agent](/tutorials/collaborative-canvas-with-agent)** — Tutorial 6's merge model with a human and an agent as co-writers.
- **[Run your first durable job](/tutorials/first-queue)** — server-only queues, workers, and cron as another paired plugin.

Or go wide: [How-to guides](/how-to/) for task recipes, [Concepts](/concepts/) for the model behind the API, [Examples](/examples/) for complete apps, and the [Control Center](/how-to/control-center) to watch a cluster like the demo's — for real deployments.
