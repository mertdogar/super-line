# Synced state (CRDT)

super-line has no built-in shared-document type — but it's an ideal **transport** for one. Keep a [CRDT](https://crdt.tech) document (Yjs, Automerge, …) per room and relay its **opaque update bytes** over a shared event. The bus never parses the document, so it stays CRDT-agnostic; the server holds the **canonical** copy, which makes it the place to **persist** state and lets the server itself be a **co-writer** alongside clients.

This is a pattern built on [events & rooms](./events-rooms) and [requests](./requests), not a feature — the [`synced-canvas` examples](https://github.com/mertdogar/super-line/tree/main/examples) implement it end to end (one with Yjs, one with Automerge).

## The wire

CRDT updates are binary; super-line's default serializer is JSON, so base64-wrap them. Three messages: a `joinDoc` request that returns the current state to catch up, a `pushUpdate` request for local edits, and a shared `update` event to fan merges out. An `origin` tag marks who wrote each update.

```ts
defineContract({
  shared: {
    serverToClient: {
      update: { payload: z.object({ docId: z.string(), update: z.string(), origin: z.enum(['peer', 'server']) }) },
    },
  },
  roles: {
    user: {
      clientToServer: {
        joinDoc: { input: z.object({ docId: z.string() }), output: z.object({ snapshot: z.string() }) },
        pushUpdate: { input: z.object({ docId: z.string(), update: z.string() }), output: z.object({ ok: z.boolean() }) },
      },
    },
  },
})
```

## Server: the canonical doc

The server materializes one document per room, hydrates it from your store, and makes the doc's own update observer the single fan-out + persist point — it fires for **both** client merges and the server's own edits.

```ts
const docs = new Map<string, Y.Doc>()
const store = new Map<string, Uint8Array>() // swap for a DB/file to survive restarts

function getDoc(docId: string): Y.Doc {
  const live = docs.get(docId)
  if (live) return live
  const doc = new Y.Doc()
  const saved = store.get(docId)
  if (saved) Y.applyUpdate(doc, saved)
  doc.on('update', (update, origin) => {
    store.set(docId, Y.encodeStateAsUpdate(doc)) // persist
    const from = origin === 'server' ? 'server' : 'peer'
    srv.room(`doc:${docId}`).broadcast('update', { docId, update: b64(update), origin: from })
  })
  docs.set(docId, doc)
  return doc
}

srv.implement({
  user: {
    joinDoc: async ({ docId }, _ctx, conn) => {
      const doc = getDoc(docId)
      srv.room(`doc:${docId}`).add(conn)
      return { snapshot: b64(Y.encodeStateAsUpdate(doc)) }
    },
    pushUpdate: async ({ docId, update }) => {
      Y.applyUpdate(getDoc(docId), unb64(update), 'client')
      return { ok: true }
    },
  },
})
```

Applying an update the doc already has is an idempotent no-op, so echoing a client's own update back to it is harmless — no special-casing needed.

## Server as a co-writer

Because the server holds the canonical doc, server-side code can edit it directly — the same observer fans the change out to every client exactly like another user's edit:

```ts
doc.transact(() => doc.getMap('state').set('status', 'published'), 'server') // → broadcast with origin 'server'
```

::: tip Authority is reactive, not preventive
A CRDT can't reject part of an update, so the server can't *veto* a client edit. As the hub it can only **react** — observe the merged state and emit a compensating edit. Treat synced-document authority as eventually-consistent last-word correction; route anything that needs a hard gate (money, permissions) through a normal [request](./requests) instead.
:::

## Client

The client holds its own doc, pushes local edits, and applies merges. The `origin` tag breaks the echo: only locally-originated updates are pushed up.

```ts
const doc = new Y.Doc()
doc.on('update', (u, origin) => {
  if (origin === 'local') client.pushUpdate({ docId, update: b64(u) })
})
client.on('update', (m) => {
  if (m.docId === docId) Y.applyUpdate(doc, unb64(m.update), m.origin)
})
await client.joinDoc({ docId }).then(({ snapshot }) => Y.applyUpdate(doc, unb64(snapshot), 'sync'))
```

(`b64` / `unb64` are base64 ⇄ `Uint8Array`; `btoa` / `atob` work in both the browser and Node 22+.)

## Scaling & gotchas

- **CRDT-agnostic.** The contract carries opaque bytes, so swapping Yjs for Automerge changes only your CRDT module — the wire is identical. (The Automerge example broadcasts `getChanges` deltas; for gap-tolerant reconnects use its `generateSyncMessage` / `receiveSyncMessage` sync protocol.)
- **Multi-node for free.** `room.broadcast` fans across nodes through the [adapter](./scaling-adapters); CRDT update bytes are just another payload. The origin-node echo-break you already use on the [cluster event bus](./cluster-event-bus) applies here too.
- **At-most-once still applies.** A client that was offline misses live updates; re-`joinDoc` on reconnect to re-snapshot (no retained/replayed topics yet).

## Running it

The [`synced-canvas-yjs`](https://github.com/mertdogar/super-line/tree/main/examples/synced-canvas-yjs) and [`synced-canvas-automerge`](https://github.com/mertdogar/super-line/tree/main/examples/synced-canvas-automerge) examples are a collaborative canvas: drag shapes across two tabs, hit “Server nudge” to see a server co-writer edit, and watch the debug panel log each patch tagged by origin (`local` / `peer` / `server`). Open either in two windows.

Next: [Roles & auth](./roles-auth).
