# Tutorial 2 · Your first collection

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <a href="/tutorials/first-round-trip">1 · Your first typed round-trip</a> → <strong>2 · Your first collection</strong> → <a href="/tutorials/go-collaborative">3 · Go collaborative</a></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
In <a href="/tutorials/first-round-trip">Tutorial 1</a> you moved messages — but they vanished the instant they were delivered. A <strong>collection</strong> is typed, persisted state the server owns and streams to every client. You declare it on the <strong>same contract</strong>, secure it with a per-row policy, and subscribe to a live, filtered row-set that updates the moment a row is written. By the end you'll watch a message land in a subscribed row-set in real time.
</p>

<p class="sl-qs-meta">
  <span>~7 minutes</span>
  <span>Builds on Tutorial 1</span>
  <span>TypeScript · zero codegen</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Declare</b> <code>collections</code></span>
  <span class="sl-qs-pill"><b>Secure</b> <code>policies</code></span>
  <span class="sl-qs-pill"><b>Subscribe</b> <code>subscribe(query)</code></span>
</p>

</div>

This lesson continues the `my-line` project from [Tutorial 1](/tutorials/first-round-trip) — same folder, same ESM + `tsx` setup, Node 18+. If you're starting cold, the three files (`package.json`, `tsconfig.json`, `src/{contract,server,client}.ts`) below are complete and copy-pasteable on their own. We're building a **row collection** — a table of many small rows. For the whole model (rows vs. documents, the division of labor), see [Collections](/collections/).

## 1. Add the collections backend

The server needs **one** collection backend — it serves every collection in a single transaction domain. Start with the in-memory one; swapping to SQLite or the self-clustering Postgres tier is a [one-line change later](/collections/backends). Everything else (`core`, `server`, `client`, the transport, `zod`) you already have from Tutorial 1.

::: code-group

```bash [pnpm]
pnpm add @super-line/collections-memory
```

```bash [npm]
npm install @super-line/collections-memory
```

```bash [yarn]
yarn add @super-line/collections-memory
```

:::

## 2. Declare the collection

Collections live on the contract, right alongside your roles — so both ends share the row type and **the server validates every write against the schema**. Replace `src/contract.ts` with a collection-focused version: a `messages` collection with a Zod schema and a primary `key`, plus a `user` role (its `clientToServer` block is empty here — the client writes rows directly, no request verbs needed).

```ts [src/contract.ts]
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const chat = defineContract({
  collections: {
    messages: {
      schema: z.object({
        id: z.string(),
        channelId: z.string(),
        authorId: z.string(),
        text: z.string(),
        createdAt: z.number(),
      }),
      key: 'id', // the primary-key field
    },
  },
  roles: { user: { clientToServer: {} } },
})
```

The row type flows end-to-end with no codegen: `RowOf<typeof chat, 'messages'>` is `{ id, channelId, authorId, text, createdAt }` on the server handle, the client handle, and every subscription. Collections and request/event verbs coexist on one contract — we dropped Tutorial 1's `send`/`message` here only to keep the lesson focused. See [Row collections](/collections/row-collections) for the full declaration surface.

## 3. Wire up the server

Three new things go on the server: the `collections` backend, an `identify` function (the **principal** every policy sees), and a `policies` block. Access control is **deny-by-default** — a collection with no policy can't be touched by clients at all. Here `read` returns a filter scoping each caller to their own channels, and `write` is author-only.

```ts [src/server.ts]
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { memoryCollections } from '@super-line/collections-memory'
import { isIn } from '@super-line/core'
import { chat } from './contract'

const server = http.createServer()

const srv = createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => ({
    role: 'user' as const,
    ctx: {
      userId: h.query.userId ?? 'anon',
      channels: (h.query.channels ?? '').split(',').filter(Boolean),
    },
  }),
  identify: (conn) => conn.ctx.userId, // the principal handed to every policy
  collections: memoryCollections(),    // one backend serves every collection
  policies: {
    messages: {
      // `read` returns a query-IR filter ANDed into every snapshot AND every live change for this caller:
      read: (_principal, ctx) => isIn('channelId', ctx.channels), // you only ever see your channels
      // `write` guards each row op — insert/update/delete:
      write: (principal, op, next, prev) =>
        op === 'delete' ? prev?.authorId === principal : next?.authorId === principal, // author-only
    },
  },
})

// Seed a little history. Server co-writes bypass policy (they're trusted) but are still schema-validated.
await srv.collection('messages').insert({ id: 'm1', channelId: 'general', authorId: 'bob', text: 'hey team', createdAt: 1 })
await srv.collection('messages').insert({ id: 'm2', channelId: 'general', authorId: 'bob', text: 'ship it?', createdAt: 2 })

server.listen(3000, () => console.log('super-line server on ws://localhost:3000'))
```

The `read`/`write` policies are the server-authoritative half a client query engine can't do on its own — [row-level security](/collections/policies) enforced at the sync source, where it can't be bypassed. Server code writing through `srv.collection('messages')` is trusted (it skips `read`/`write`) but is **still schema-validated** — that's the door for seeds and business-logic mutations a handler owns.

## 4. Subscribe and write from the client

The client imports the **same** contract, so `client.collection('messages')` is fully typed. `subscribe(query)` opens a **live row-set**: an initial snapshot, then per-row change events, auto-resubscribed and re-diffed across reconnects. Await `sub.ready` before you depend on live delivery, render `sub.rows()`, then insert a row and watch the live listener fire.

```ts [src/client.ts]
import { randomUUID } from 'node:crypto'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { eq } from '@super-line/core'
import { chat } from './contract'

const client = createSuperLineClient(chat, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
  role: 'user',
  params: { userId: 'ada', channels: 'general' }, // carried in the handshake → readable as h.query
})

const messages = client.collection('messages') // typed by the contract

const sub = messages.subscribe({
  filter: eq('channelId', 'general'),           // only #general rows — the server enforces it too
  orderBy: [{ field: 'createdAt', dir: 'asc' }],
})
await sub.ready                                  // frames process concurrently — await before you depend on live delivery

console.log('history:', sub.rows().map((m) => `${m.authorId}: ${m.text}`)) // the seeded snapshot, ordered

// React to every future change to the row-set.
sub.subscribe((ev) => {
  if (ev.type === 'insert') console.log(`💬 ${ev.row.authorId}: ${ev.row.text}`)
})

// Write a row Ada authored — the write policy is author-only, so authorId must be her principal.
await messages.insert({
  id: randomUUID(),
  channelId: 'general',
  authorId: 'ada',
  text: 'hello, persisted world',
  createdAt: Date.now(),
})

await new Promise((r) => setTimeout(r, 300)) // let the live insert land, then exit
client.close()
```

::: tip Await `sub.ready`
The subscription's frames process concurrently, so `sub.ready` is the barrier before you can trust `sub.rows()` or live delivery. This is a hard rule for the raw sync layer.
:::

::: tip The primitive is non-optimistic
`client.collection(name)` is the raw sync layer: a write appears in `rows()` (and fires the `insert` event) when the **server confirms** it. Instant local application with rollback-on-error is [TanStack DB's](/collections/tanstack-db) job, layered on top — you'll reach for it in Tutorial 3.
:::

## 5. Run it

Start the server, then the client in a second terminal — exactly as in Tutorial 1:

::: code-group

```bash [Terminal 1 · server]
npm run server
```

```bash [Terminal 2 · client]
npm run client
```

:::

The client prints the seeded snapshot, then the row it just wrote arriving live:

```ansi
history: [ 'bob: hey team', 'bob: ship it?' ]
💬 ada: hello, persisted world
```

<div class="sl-result">
  <p class="sl-result__h">That's a live, secured, filtered row-set.</p>
  <p>The <code>history:</code> line is the initial <strong>snapshot</strong> the server streamed on subscribe; the <code>ada: …</code> line is your <code>insert</code> <strong>arriving back through the live subscription</strong> — validated against the schema, allowed by the author-only write policy, and delivered because it matched the <code>#general</code> filter. Nothing appeared until the server confirmed it.</p>
</div>

## What just happened

Each piece you wrote is one half of super-line's collections split — the server syncs authoritatively, the client subscribes:

| What you wrote | Role | What it does |
| --- | --- | --- |
| `collections: { messages: { schema, key } }` | **Contract** | Declares a typed table; the server validates every write against it. |
| `identify` + `policies.messages` | **Server (RLS)** | Deny-by-default `read` filter + `write` guard, enforced at the source. |
| `messages.subscribe({ filter })` | **Client** | A live row-set — snapshot, then per-row change events. |
| `messages.insert(row)` | **Client** | A non-optimistic write; lands in the row-set once the server confirms. |

The filter isn't just a client convenience — the server **pushes it down** and re-checks the exact predicate, so a caller can never subscribe past their policy. Try it: change the client's `channels` to `'random'` and the seeded `#general` snapshot disappears — the `read` policy scopes the caller to channels they're in, on both the snapshot and the live path. The full operator set (`and`/`or`/`not`, comparisons, `in`, `like`) is in [Row collections](/collections/row-collections#the-query-ir).

## The same, in React (optional)

For a simple filtered list, `useCollection` is a thin, typed hook — the same subscription behind a React surface. Wire your typed hooks once (see [Use the React hooks](/how-to/react)), then:

```tsx
import { eq } from '@super-line/core'

function Channel() {
  const { rows, insert } = useCollection('messages', { filter: eq('channelId', 'general') })
  return (
    <ul>
      {rows.map((m) => (
        <li key={m.id}>{m.authorId}: {m.text}</li>
      ))}
    </ul>
  )
}
```

For joins and complex live queries, point [TanStack DB](/collections/tanstack-db) at the collection instead — that's the next tutorial.

## Next: joins, optimism, and a browser app

You have a live, secured row-set. The next leap is the **client query engine**: join two synced collections, get instant optimistic writes with rollback, and put it all in a browser — that's [TanStack DB](/collections/tanstack-db) over the same sync source.

<div class="sl-result">
  <p class="sl-result__h">Continue the series</p>
  <p><strong><a href="/tutorials/go-collaborative">Tutorial 3 · Go collaborative →</a></strong> — join collections, add optimistic mutations, and watch a filtered feed update live across two browser tabs.</p>
</div>

### Or branch off from here

- [Row collections](/collections/row-collections) — the full write, subscribe, and batch API.
- [Row-level security & policies](/collections/policies) — the `read` filter, `write` guard, and policy staleness in depth.
- [Querying with TanStack DB](/collections/tanstack-db) — joins, live queries, and optimism.
- [Backends & clustering](/collections/backends) — swap in-memory for SQLite or the self-clustering Postgres tier.
- [`examples/collections`](https://github.com/mertdogar/super-line/tree/main/examples/collections) — a runnable `tsx` tracer: RLS pushdown, a `messages ⋈ users` join, and optimistic writes with rollback in ~120 lines.
- [API reference](/reference/) — every export, option, and type.
