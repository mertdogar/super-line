# Tutorial 3 · Go collaborative

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <a href="/tutorials/first-collection">2 · Your first collection</a> → <strong>3 · Go collaborative</strong></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
Two tabs edit the <strong>same document</strong> at the same time — and when they change <em>different</em> fields, both edits survive. That's a <strong>CRDT document collection</strong>: one <code>collection(n)</code> concept away from Tutorial 2's rows, but with <strong>merge</strong> instead of last-writer-wins. You'll declare one on the contract, secure it with a guard, and watch two clients converge.
</p>

<p class="sl-qs-meta">
  <span>~7 minutes</span>
  <span>Node 18+</span>
  <span>builds on Tutorial 2</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Open</b> <code>open('board')</code></span>
  <span class="sl-qs-pill"><b>Merge</b> <code>update()</code></span>
  <span class="sl-qs-pill"><b>Live</b> <code>subscribe()</code></span>
</p>

</div>

This lesson picks up where [Tutorial 2 · Your first collection](/tutorials/first-collection) left off — same contract-first setup, same WebSocket wire. A [row collection](/collections/row-collections) is last-writer-wins: two writers touching one row, the last one clobbers the first. Some state doesn't want that — a canvas, a rich-text doc, a scene graph want two people editing different fields to **converge**. That's what a CRDT document collection gives you, and the only new dependency is its backend.

## 1. Add the CRDT backend

Start from the project you built in Tutorial 1 (`core` · `server` · `client` · `transport-websocket` · `zod`). The one addition is the in-memory CRDT backend, which also ships the universal client engine:

::: code-group

```bash [pnpm]
pnpm add @super-line/collections-crdt-memory
```

```bash [npm]
npm install @super-line/collections-crdt-memory
```

```bash [yarn]
yarn add @super-line/collections-crdt-memory
```

:::

Starting fresh? Grab the rest too: `@super-line/core @super-line/server @super-line/client @super-line/transport-websocket zod`, plus `-D tsx typescript` — see [Tutorial 1 · steps 1–2](/tutorials/first-round-trip) for the `package.json` (`"type": "module"`) and `tsconfig.json`.

## 2. Declare a document collection

A CRDT collection is declared with a `crdt` option instead of a `key` — it's **opened by id, not queried** (id is external, not extracted from the body). Every write is validated against this schema, so keep the concurrently-mutated fields **tolerant**:

```ts [src/contract.ts]
import { z } from 'zod'
import { defineContract } from '@super-line/core'

// Both fields get edited concurrently, so keep them tolerant: use `.catch(default)`
// so a transient post-merge gap coerces to a default instead of rejecting the write.
const boardSchema = z.object({
  title: z.string().catch('untitled'),
  color: z.string().catch('gray'),
})

export const board = defineContract({
  collections: {
    scenes: { schema: boardSchema, crdt: { mode: 'document' } }, // CRDT doc — opened by id, merges
  },
  roles: {
    user: { clientToServer: {} }, // no requests this time — the document is the whole app
  },
})
```

::: warning Keep CRDT schemas tolerant
Validation runs against the *post-merge* state, which a concurrent merge can leave **momentarily incomplete** — an overwrite of a field is internally a delete-then-insert, and the delete can land a beat before the insert. If the schema hard-requires a field that is concurrently overwritten, that transient gap is rejected, the writer resyncs, and the churn can permanently wedge the document. So for any field that is concurrently mutated, prefer `z.string().catch('untitled')` / `.optional()` over a bare `z.string()`. Reserve strict/required for fields written once and never concurrently overwritten. See [CRDT document collections](/collections/crdt-documents) for the full rule.
:::

## 3. Implement the server

Give the server a **CRDT backend** (a separate backend from the [row backend](/collections/backends) — a CRDT doc never joins a cross-collection atomic batch) and a **guard-shaped policy** (deny-by-default: omit `read`/`write` and it's denied). **Creation is server-authoritative** — clients open existing documents, so the server seeds the board once at boot:

```ts [src/server.ts]
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { board } from './contract'

const server = http.createServer()

const srv = createSuperLineServer(board, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => {
    const name = h.query.name
    if (!name) throw new Error('unauthorized')
    return { role: 'user' as const, ctx: { name } }
  },
  crdtCollections: crdtMemoryCollections(), // the CRDT backend
  policies: {
    scenes: {
      read: (_principal, _id, _snapshot, _ctx) => true, // this open demo lets everyone read…
      write: (_principal, _id, _ctx) => true, // …and write the shared board
    },
  },
})

// Creation is server-authoritative — clients open this doc, they can't create it.
await srv.collection('scenes').create('board', { title: 'untitled', color: 'gray' })

server.listen(3000, () => console.log('super-line server on ws://localhost:3000'))
```

Opening a nonexistent document returns `NOT_FOUND`; a client that needs to create one routes through a request handler that calls `create`.

## 4. Open the document in two tabs

The client needs the universal `crdtCollectionsClient()` engine — one client engine pairs with every backend tier, since the client only merges opaque deltas. Here two independent clients stand in for two browser tabs: each opens the **same** document by id, subscribes to re-render, and edits a **different** field at the same instant.

```ts [src/client.ts]
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { board } from './contract'

// Each client is one "tab" — its own connection, its own handle on the shared doc.
function tab(name: string) {
  return createSuperLineClient(board, {
    transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
    role: 'user',
    params: { name },
    crdtCollections: crdtCollectionsClient(), // the universal client engine
  })
}

const ada = tab('ada')
const bob = tab('bob')

const adaDoc = ada.collection('scenes').open('board')
const bobDoc = bob.collection('scenes').open('board')
await Promise.all([adaDoc.ready, bobDoc.ready]) // catch up to the server snapshot

// Each tab re-renders on every merge — its own edits and the other tab's.
adaDoc.subscribe(() => console.log('ada sees', adaDoc.getSnapshot()))
bobDoc.subscribe(() => console.log('bob sees', bobDoc.getSnapshot()))

// Concurrent edits to DIFFERENT fields — no last-writer-wins clobber.
adaDoc.update({ title: 'Roadmap' }) // ada renames the board…
bobDoc.update({ color: 'blue' }) // …while bob recolors it

await new Promise((r) => setTimeout(r, 300)) // let the merges propagate
console.log('\nconverged:', adaDoc.getSnapshot())

ada.close()
bob.close()
```

::: warning Node 18 / 20: provide a WebSocket
The client uses the global `WebSocket`, which exists in browsers and **Node 22+**. On older Node, install `ws` and pass it through: `webSocketClientTransport({ url, WebSocket })`.
:::

## 5. Run it

Start the server, then the client in a second terminal:

::: code-group

```bash [Terminal 1 · server]
npm run server
```

```bash [Terminal 2 · client]
npm run client
```

:::

Each tab logs on every merge — first its own edit, then the other tab's landing — and the two converge (interleaving varies run to run):

```ansi
ada sees { title: 'Roadmap', color: 'gray' }
bob sees { title: 'untitled', color: 'blue' }
bob sees { title: 'Roadmap', color: 'blue' }
ada sees { title: 'Roadmap', color: 'blue' }

converged: { title: 'Roadmap', color: 'blue' }
```

<div class="sl-result">
  <p class="sl-result__h">Both edits survived.</p>
  <p>Ada renamed the board and Bob recolored it <strong>at the same time</strong>, and the document converged to <code>{ title: 'Roadmap', color: 'blue' }</code> — neither write clobbered the other. That's the CRDT difference: a <a href="/collections/row-collections">row</a> is last-writer-wins, but a document <strong>merges</strong>.</p>
</div>

## What just happened

| Your call | What it does |
| --- | --- |
| `client.collection('scenes').open('board')` | Opens the shared document **by id** and returns a reactive handle. |
| `await doc.ready` | Waits for the catch-up snapshot to land before you depend on live delivery. |
| `doc.subscribe(() => …)` | Fires on every merge — local edits **and** remote ones. Read `doc.getSnapshot()` inside. |
| `doc.update({ … })` | Merges a partial into the doc and syncs it to every open handle. |

The merge isn't a free-for-all: writes are **validated before they commit**. When a write arrives, the ingress node merges the delta onto a scratch copy, snapshots it to plaintext, validates against the contract schema, and only **then** commits and fans it out — an invalid write is rejected server-side and never reaches other tabs; the writer resyncs. That's why your schema had to be tolerant in step 2: validation runs on the post-merge state, and a strict-required field that's concurrently overwritten can transiently be absent.

And the guard is **deny-by-default** — this demo opened `read`/`write` to everyone, but omit either and that operation is denied.

## Next

<div class="sl-result">
  <p class="sl-result__h">One lesson left</p>
  <p>A typed round-trip, a live row collection, and a merging document — the three shapes of state super-line moves. Now assemble them into a real feature with a reusable plugin.</p>
</div>

- **[Tutorial 4 · Assemble a chat backbone →](/tutorials/chat-backbone)** — merge the auth and chat plugins into one contract and watch two users talk over a model you never wrote a policy or handler for.
- [Collections overview](/collections/) — rows and documents side by side, and when to reach for each.
- [CRDT document collections](/collections/crdt-documents) — validate-before-commit, schema tolerance, and the server co-writer in depth.
- [`examples/ai-canvas`](https://github.com/mertdogar/super-line/tree/main/examples/ai-canvas) — this tutorial's ideas as a real browser app: a collaborative canvas with a **server-side AI agent** as a co-writer (`srv.collection('scene').open(id)`) — open two tabs, keep editing while the agent drives, and the edits merge.
- [API reference](/reference/) — every export, option, and type.
