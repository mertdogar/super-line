<script setup>
import RoundTripDemo from '../.vitepress/theme/components/demos/RoundTripDemo.vue'
</script>

# Tutorial 2 · Connect a typed client

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <a href="/tutorials/run-a-server">1 · Run a server</a> → <strong>2 · Connect a typed client</strong> → <a href="/tutorials/react-hooks">3 · Make it React</a></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
The server from <a href="/tutorials/run-a-server">Tutorial 1</a> is waiting. Now the client imports the <strong>same contract</strong> — so the request, the event, and the topic are all inferred, end to end, with zero codegen. You'll exercise all three patterns over one connection, and watch the server refuse a payload TypeScript would never have let you write.
</p>

<p class="sl-qs-meta">
  <span>~6 minutes</span>
  <span>Builds on Tutorial 1</span>
  <span>TypeScript · zero codegen</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Request</b> <code>send()</code></span>
  <span class="sl-qs-pill"><b>Event</b> <code>on('message')</code></span>
  <span class="sl-qs-pill"><b>Topic</b> <code>subscribe('presence')</code></span>
</p>

</div>

## First, see it run

Tutorial 1's server, plus **two real clients** — ada and bob. Join the room on both sides and talk; toggle the `presence` topic off and watch deliveries stop for that client only; then press *send an invalid payload* to see the server's answer to a hand-crafted bad frame.

<RoundTripDemo />

Notice bob receives nothing until he **joins** — room membership lives on the server, not in the client. And the invalid payload comes back as a typed `SuperLineError`: types make the wrong thing *hard to write*, but it's the server's re-validation that makes it *impossible to slip through*.

## 1. Add the client package

In the `my-line` project from Tutorial 1:

::: code-group

```bash [pnpm]
pnpm add @super-line/client
```

```bash [npm]
npm install @super-line/client
```

```bash [yarn]
yarn add @super-line/client
```

:::

And a script for it in `package.json`:

```json
"scripts": {
  "server": "tsx src/server.ts",
  "client": "tsx src/client.ts" // [!code ++]
}
```

## 2. Write the client

The client imports the **same** `contract.ts`, so `join`, `send`, `on`, and `subscribe` are all inferred — a wrong event name or a bad payload is a compile error, not a runtime surprise.

```ts [src/client.ts]
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { chat } from './contract'

const client = createSuperLineClient(chat, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
  role: 'user', // narrows the surface to shared ∪ user; verified by authenticate
  params: { name: 'ada' }, // carried in the handshake → readable as h.query.name
})

client.on('message', (m) => console.log(`💬 ${m.from}: ${m.text}`)) // event
client.subscribe('presence', (p) => console.log(`👥 ${p.count} online in ${p.room}`)) // topic

await client.join({ room: 'lobby' })
await client.send({ room: 'lobby', text: 'hello, super-line' }) // request → typed { id }

await new Promise((r) => setTimeout(r, 300)) // let the pushes land, then exit
client.close()
```

::: warning Node 18 / 20: provide a WebSocket
The client uses the global `WebSocket`, which exists in browsers and **Node 22+**. On older Node, install `ws` and pass it through: `webSocketClientTransport({ url, WebSocket })`.
:::

## 3. Run the round-trip

Start the server, then the client in a second terminal:

::: code-group

```bash [Terminal 1 · server]
npm run server
```

```bash [Terminal 2 · client]
npm run client
```

:::

The client prints:

```ansi
👥 1 online in lobby
💬 ada: hello, super-line
```

<div class="sl-result">
  <p class="sl-result__h">That's a full typed round-trip.</p>
  <p>One contract, three wire patterns, end to end. The <code>presence</code> line is a <strong>topic</strong> the server pushed on join; the <code>ada: …</code> line is an <strong>event</strong> broadcast from your <code>send</code> <strong>request</strong> — all over a single connection, with zero codegen.</p>
</div>

## What just happened

| Your client call | Pattern | What it does |
| --- | --- | --- |
| `await client.send(…)` | **Request** | Validated input in, typed `{ id }` back — like an RPC. |
| `client.on('message', …)` | **Event** | The server pushes; you listen. Fire-and-forget. |
| `client.subscribe('presence', …)` | **Topic** | You opt in; the server fans out to every subscriber. Unsubscribe and deliveries stop — try the toggle in the demo. |

Rename a field in `contract.ts` and the other side stops compiling — that's the contract earning its keep. And types aren't trust: every inbound payload is **re-validated against the schema on the server**, so even an untyped peer can't slip a bad message through. That's what the demo's *invalid payload* button proves — it bypasses TypeScript on purpose and gets a `SuperLineError` back.

## Next: put a UI on it

Console logs prove the wire works. Real apps render it — and the React binding turns each of these three patterns into a hook.

<div class="sl-result">
  <p class="sl-result__h">Continue the series</p>
  <p><strong><a href="/tutorials/react-hooks">Tutorial 3 · Make it React →</a></strong> — typed hooks for requests, events, topics, and live data — with two real React apps running on this site.</p>
</div>

### Or branch off from here

- [Implement requests](/how-to/requests) · [Push events & rooms](/how-to/events-rooms) · [Subscribe to topics](/how-to/topics) — each pattern, in depth.
- [Handle errors](/how-to/errors) — `SuperLineError`, codes, and where they surface.
- [Reconnection & delivery](/concepts/reconnection-delivery) — what happens when the wire drops.
- [Test your app](/how-to/testing) — the loopback transport the in-page demos use is also the test transport.
