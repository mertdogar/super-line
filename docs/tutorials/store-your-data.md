<script setup>
import CollectionsDemo from '../.vitepress/theme/components/demos/CollectionsDemo.vue'
</script>

# Tutorial 4 · Store your data

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <a href="/tutorials/react-hooks">3 · Make it React</a> → <strong>4 · Store your data</strong> → <a href="/tutorials/add-auth-and-chat">5 · Add auth + chat</a></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
So far you've moved messages; they vanished on delivery. A <strong>collection</strong> is typed, persisted state the server owns and streams to every subscriber — the machinery behind Tutorial 3's <code>useCollection</code>. You'll declare one on the contract, fence it with <strong>row-level policies</strong>, hand the server a <strong>storage backend</strong> — and then kill the server to prove the data doesn't live in it.
</p>

<p class="sl-qs-meta">
  <span>~8 minutes</span>
  <span>Builds on Tutorial 3</span>
  <span>TypeScript · zero codegen</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Declare</b> <code>collections</code></span>
  <span class="sl-qs-pill"><b>Secure</b> <code>policies</code></span>
  <span class="sl-qs-pill"><b>Persist</b> a backend</span>
</p>

</div>

## First, see it run

A private `notes` collection: ada and bob each see **only their own rows** — that fence is the server's `read` policy, not UI politeness, and the *forge* button proves the `write` guard too. Then the showpiece: **stop the server**, boot a brand-new one on the **same backend**, and watch every row come back.

<CollectionsDemo />

::: info Three words that sound alike — and aren't
**Transport** (Tutorial 1) carries client↔server bytes. A **backend** (this lesson) is where collection rows live — memory, SQLite, Postgres. An **adapter** (Tutorial 7) fans events out server↔server across a cluster. You configure each independently; confusing them is the classic super-line vocabulary trap.
:::

## 1. Add a collections backend

One backend serves **every** collection on the server (a single transaction domain — cross-collection batches stay atomic). Start in-memory; you'll swap it for SQLite at the end without touching any other line.

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

Collections live **on the contract**, so both ends share the row type and the server validates every write against the schema. Replace `src/contract.ts`:

```ts [src/contract.ts]
import * as z from 'zod'
import { defineContract } from '@super-line/core'

export const app = defineContract({
  collections: {
    notes: {
      schema: z.object({
        id: z.string(),
        ownerId: z.string(),
        text: z.string(),
        createdAt: z.number(),
      }),
      key: 'id', // the primary-key field
    },
  },
  roles: { user: { clientToServer: {} } }, // no request verbs needed — rows are the surface
})
```

The row type flows with no codegen: `RowOf<typeof app, 'notes'>` is the same object on the server handle, the client handle, and every subscription. Collections coexist with the request/event/topic verbs from Tutorials 1–2 on one contract — we drop them here only to keep the lesson focused.

## 3. Wire the server: identity, backend, policies

Three new options. `identify` names the **principal** every policy sees. `collections` is the backend. `policies` is row-level security, **deny-by-default** — a collection without a policy can't be touched by clients at all.

```ts [src/server.ts]
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { memoryCollections } from '@super-line/collections-memory'
import { eq } from '@super-line/core'
import { app } from './contract'

const server = http.createServer()

const srv = createSuperLineServer(app, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => ({
    role: 'user' as const,
    ctx: { userId: h.query.userId ?? 'anon' }, // handshake identity — a REAL login replaces this in Tutorial 5
  }),
  identify: (conn) => conn.ctx.userId, // the principal handed to every policy
  collections: memoryCollections(),    // one backend serves every collection
  policies: {
    notes: {
      // `read` returns a query-IR filter ANDed into every snapshot AND every live change:
      read: (principal) => eq('ownerId', principal), // you only ever SEE your own rows
      // `write` guards each row op — insert/update/delete:
      write: (principal, op, next, prev) =>
        op === 'delete' ? prev?.ownerId === principal : next?.ownerId === principal,
    },
  },
})

server.listen(3000, () => console.log('super-line server on ws://localhost:3000'))
```

This is the server-authoritative half a client query engine can't fake: the filter is enforced **at the sync source**, on the snapshot and on every live change, where a tampered client can't reach it. Server code writing through `srv.collection('notes')` is trusted (skips `read`/`write`) but **still schema-validated** — the door for seeds and business-logic mutations.

## 4. Subscribe and write from the client

`subscribe(query)` opens a **live row-set**: a snapshot, then per-row change events, re-subscribed and re-diffed across reconnects. This tracer connects ada and bob and lets each try to read past their fence:

```ts [src/client.ts]
import { randomUUID } from 'node:crypto'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { app } from './contract'

const connect = (userId: string) =>
  createSuperLineClient(app, {
    transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
    role: 'user',
    params: { userId },
  })

const ada = connect('ada')
const bob = connect('bob')

await ada.collection('notes').insert({ id: randomUUID(), ownerId: 'ada', text: 'my private note', createdAt: Date.now() })
await bob.collection('notes').insert({ id: randomUUID(), ownerId: 'bob', text: 'bob-only', createdAt: Date.now() })

const adaNotes = ada.collection('notes').subscribe({ orderBy: [{ field: 'createdAt', dir: 'asc' }] })
const bobNotes = bob.collection('notes').subscribe({ orderBy: [{ field: 'createdAt', dir: 'asc' }] })
await Promise.all([adaNotes.ready, bobNotes.ready]) // frames process concurrently — await before trusting rows()

console.log('ada sees →', adaNotes.rows().map((n) => n.text))
console.log('bob sees →', bobNotes.rows().map((n) => n.text))

// The forge: ada plants a row owned by bob. The write policy must refuse it.
await ada.collection('notes')
  .insert({ id: randomUUID(), ownerId: 'bob', text: 'forged!', createdAt: Date.now() })
  .catch((err) => console.log('forged insert →', err.code))

ada.close()
bob.close()
```

::: tip Await `sub.ready`
The subscription's frames process concurrently, so `sub.ready` is the barrier before you can trust `sub.rows()` or live delivery. Hard rule for the raw sync layer. (Tutorial 3's `useCollection` surfaces the same thing as its `ready` flag.)
:::

::: tip The primitive is non-optimistic
A write appears in `rows()` when the **server confirms** it. Instant local application with rollback is [TanStack DB's](/collections/tanstack-db) job, layered on top.
:::

## 5. Run it

::: code-group

```bash [Terminal 1 · server]
npm run server
```

```bash [Terminal 2 · client]
npm run client
```

:::

```ansi
ada sees → [ 'my private note' ]
bob sees → [ 'bob-only' ]
forged insert → FORBIDDEN
```

## 6. Now swap the backend — one line

The demo's kill-the-server trick works because rows live in the **backend**, not the server process. In-memory dies with the process; durable backends don't. The swap:

```ts [src/server.ts]
import { memoryCollections } from '@super-line/collections-memory' // [!code --]
import { sqliteCollections } from '@super-line/collections-sqlite' // [!code ++]

  collections: memoryCollections(), // [!code --]
  collections: sqliteCollections({ file: './data.db', collections: app.collections }), // [!code ++]
```

(`pnpm add @super-line/collections-sqlite` first.) Restart the server between client runs and the notes survive for real — each collection stored in its own typed-column table derived from your schema. When you outgrow one node, `@super-line/collections-pglite` is the cluster tier: central Postgres, per-node replicas, same contract. See [Backends & clustering](/collections/backends).

<div class="sl-result">
  <p class="sl-result__h">Typed rows, fenced by the server, stored behind a seam.</p>
  <p>The schema validated every write; <code>identify</code> + the <code>read</code> filter fenced each caller to their own rows; the forged write bounced off the <code>write</code> guard; and the backend — not the server — owns the bytes, which is why the demo's server #2 came up with everything intact.</p>
</div>

## What just happened

| What you wrote | Role | What it does |
| --- | --- | --- |
| `collections: { notes: { schema, key } }` | **Contract** | Declares a typed table; every write validated against it. |
| `identify` + `policies.notes` | **Server (RLS)** | Deny-by-default `read` filter + `write` guard, enforced at the source. |
| `collection('notes').subscribe(query)` | **Client** | A live row-set — snapshot, then per-row changes. `useCollection` wraps exactly this. |
| `memoryCollections()` → `sqliteCollections(…)` | **Backend** | Where rows live. Swappable without touching contract, policies, or clients. |

## Next: stop faking identity

That `h.query.userId` handshake is a placeholder — anyone can claim any name. Real sign-up, sessions, and roles are a plugin you merge onto this exact contract, and `principal` becomes a logged-in user.

<div class="sl-result">
  <p class="sl-result__h">Continue the series</p>
  <p><strong><a href="/tutorials/add-auth-and-chat">Tutorial 5 · Add auth + chat →</a></strong> — two plugins, one contract: real login on your policies, and a whole chat domain you never wrote.</p>
</div>

### Or branch off from here

- [Row collections](/collections/row-collections) — the full write/subscribe/batch API and the query IR (`and`/`or`/`in`/`like`…).
- [Row-level security & policies](/collections/policies) — the `read` filter and `write` guard in depth.
- [Choose a collection backend](/how-to/choose-a-collection-backend) — memory vs. SQLite vs. the Postgres cluster tier.
- [Querying with TanStack DB](/collections/tanstack-db) — joins and optimistic writes over this sync source.
