<script setup>
import CrdtDemo from '../.vitepress/theme/components/demos/CrdtDemo.vue'
</script>

# Tutorial 6 · Collaborate on one document

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <a href="/tutorials/add-auth-and-chat">5 · Add auth + chat</a> → <strong>6 · Collaborate on one document</strong> → <a href="/tutorials/go-multi-node">7 · Go multi-node</a></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
A <a href="/collections/row-collections">row</a> is last-writer-wins: two writers on one row, the second clobbers the first. A canvas, a rich-text doc, a scene graph want the opposite — two people editing <em>different parts at the same time</em>, both edits surviving. That's a <strong>CRDT document collection</strong>: the same <code>collection(n)</code> concept, a different consistency model — <strong>merge</strong> — and every write is <em>still</em> validated against your schema before it commits.
</p>

<p class="sl-qs-meta">
  <span>~8 minutes</span>
  <span>Builds on Tutorial 4</span>
  <span>TypeScript · zero codegen</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Open</b> <code>open('board')</code></span>
  <span class="sl-qs-pill"><b>Merge</b> <code>update()</code></span>
  <span class="sl-qs-pill"><b>Validate</b> before commit</span>
</p>

</div>

## First, see it run

One document, **two real clients**. Type a title on ada's side while picking a color on bob's — both land. The first footer button runs the exact concurrent-edit test you're about to write; the second sends a write that breaks the schema and shows the server refusing to commit it.

<CrdtDemo />

## 1. Add the CRDT backend

Start from the `my-line` project (Tutorials 1–4). CRDT documents use a **separate backend** from row collections — a document never joins a cross-collection atomic batch — and the memory package also ships the universal client engine:

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

## 2. Declare a document collection

A CRDT collection is declared with `crdt` instead of `key` — it's **opened by id, not queried** (the id is external; the whole document syncs). Because validation runs on the *post-merge* state, concurrently-edited fields must be **tolerant**:

```ts [src/contract.ts]
import * as z from 'zod'
import { defineContract } from '@super-line/core'

const boardSchema = z.object({
  kind: z.literal('board'), // strict is fine here: written once at create, never edited
  // Concurrently-edited fields get `.catch(default)` — a transient post-merge gap
  // coerces to the default instead of rejecting the write.
  title: z.string().catch('untitled'),
  color: z.string().catch('gray'),
})

export const board = defineContract({
  collections: {
    scenes: { schema: boardSchema, crdt: { mode: 'document' } },
  },
  roles: { user: { clientToServer: {} } },
})
```

::: warning Keep concurrently-edited fields tolerant
An overwrite is internally a delete-then-insert, and under concurrency the delete can land a beat before the insert. A schema that hard-requires such a field rejects that transient gap, the writer resyncs, and the churn can wedge the document. Rule of thumb: `.catch()`/`.optional()` for anything edited concurrently; strict/required only for fields written once (like `kind` above). See [CRDT document collections](/collections/crdt-documents).
:::

## 3. Server: backend, guard, create

Three CRDT-specific pieces: the `crdtCollections` backend, a **guard-shaped** policy (booleans per open/write — not the row filter shape, because a document is opened whole), and **server-authoritative creation** — clients open existing docs; they can't create them:

```ts [src/server.ts]
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'
import { board } from './contract'

const server = http.createServer()

const srv = createSuperLineServer(board, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => {
    const name = h.query.name
    if (!name) throw new Error('unauthorized')
    return { role: 'user' as const, ctx: { name } }
  },
  crdtCollections: crdtMemoryCollections(), // the CRDT backend (separate seam from rows)
  policies: {
    scenes: {
      read: () => true,  // guard-shaped: may the caller OPEN this doc? (gets principal, id, snapshot)
      write: () => true, // may they write to it? Deny-by-default — omit either and it's denied.
    },
  },
})

// Clients open this doc; opening a nonexistent id → NOT_FOUND.
await srv.collection('scenes').create('board', { kind: 'board', title: 'untitled', color: 'gray' })

server.listen(3000, () => console.log('super-line server on ws://localhost:3000'))
```

## 4. Open it from two "tabs"

The client needs the universal `crdtCollectionsClient()` engine — one engine pairs with every backend tier, because the client only merges opaque deltas. Two clients stand in for two browser tabs; each opens the **same** document and edits a **different** field at the same instant:

```ts [src/client.ts]
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { board } from './contract'

const tab = (name: string) =>
  createSuperLineClient(board, {
    transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
    role: 'user',
    params: { name },
    crdtCollections: crdtCollectionsClient(), // the universal client engine
  })

const ada = tab('ada')
const bob = tab('bob')

const adaDoc = ada.collection('scenes').open('board')
const bobDoc = bob.collection('scenes').open('board')
await Promise.all([adaDoc.ready, bobDoc.ready]) // catch up to the server snapshot first

adaDoc.subscribe(() => console.log('ada sees', adaDoc.getSnapshot()))
bobDoc.subscribe(() => console.log('bob sees', bobDoc.getSnapshot()))

// Concurrent edits to DIFFERENT fields — no last-writer-wins clobber.
adaDoc.update({ title: 'Roadmap' }) // ada renames…
bobDoc.update({ color: 'blue' })    // …while bob recolors

await new Promise((r) => setTimeout(r, 300))
console.log('\nconverged:', adaDoc.getSnapshot())

ada.close()
bob.close()
```

## 5. Run it

::: code-group

```bash [Terminal 1 · server]
npm run server
```

```bash [Terminal 2 · client]
npm run client
```

:::

Each tab logs on every merge — its own edit, then the other's landing — and both converge (interleaving varies run to run):

```ansi
ada sees { kind: 'board', title: 'Roadmap', color: 'gray' }
bob sees { kind: 'board', title: 'untitled', color: 'blue' }
bob sees { kind: 'board', title: 'Roadmap', color: 'blue' }
ada sees { kind: 'board', title: 'Roadmap', color: 'blue' }

converged: { kind: 'board', title: 'Roadmap', color: 'blue' }
```

<div class="sl-result">
  <p class="sl-result__h">Both edits survived.</p>
  <p>Ada renamed while bob recolored, <strong>at the same time</strong>, and the document converged with both — that's the CRDT difference. And it wasn't a free-for-all: try the demo's <em>invalid write</em> button — the server merges each delta onto a scratch copy, validates the result against your schema, and only then commits and fans out. Invalid deltas never reach other tabs; the writer resyncs.</p>
</div>

## What just happened

| Your call | What it does |
| --- | --- |
| `{ schema, crdt: { mode: 'document' } }` | Declares a document collection — opened by id, merged, schema-validated. |
| `srv.collection('scenes').create(id, data)` | Server-authoritative creation; clients only open. |
| `client.collection('scenes').open('board')` | A reactive `DocHandle` on the shared doc. |
| `await doc.ready` | The catch-up barrier — same rule as `sub.ready` in Tutorial 4. |
| `doc.update({ … })` / `doc.subscribe(…)` | Merge a partial in; re-render on every merge, local and remote. |

In React it's one hook: `useDoc('scenes', 'board')` returns `{ data, ready, error, set, update }` and re-renders on every merge — plus `native` for binding rich-text editors. Access control is the guard you wrote: deny-by-default per open/write, with the current snapshot available to the `read` guard for ownership checks.

## Next: more than one server

Everything so far ran on a single node. The last lesson snaps the ceiling: two servers, one adapter bus, and the same contract serving clients on both — including a live severable cluster in the page.

<div class="sl-result">
  <p class="sl-result__h">Continue the series</p>
  <p><strong><a href="/tutorials/go-multi-node">Tutorial 7 · Go multi-node →</a></strong> — the adapter seam, the cluster event bus, and a two-node cluster you can sever with a button.</p>
</div>

### Or branch off from here

- [CRDT document collections](/collections/crdt-documents) — validate-before-commit, schema tolerance, and the server co-writer in depth.
- [Collections overview](/collections/) — rows vs. documents, and when to reach for each.
- [Attach channel resources](/how-to/chat-resources) — CRDT docs linked to chat channels (how Tutorial 5 and this one combine).
- [Going deeper · Co-edit a canvas with an agent](/tutorials/collaborative-canvas-with-agent) — a human and an AI agent as co-writers on one doc.
