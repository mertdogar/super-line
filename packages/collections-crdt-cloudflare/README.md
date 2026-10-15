# @super-line/collections-crdt-cloudflare

[**super-line**](https://super-line.dogar.biz/) [CRDT document collections](https://super-line.dogar.biz/collections/crdt-documents) stored in a Cloudflare **Durable Object's** own SQLite — the object that is the node (see [`@super-line/transport-cloudflare`](https://github.com/mertdogar/super-line/tree/main/packages/transport-cloudflare)). It merges with [`@super-line/collections-crdt-memory`](https://github.com/mertdogar/super-line/tree/main/packages/collections-crdt-memory)'s Yjs engine and snapshots each document to one row of `_sl_crdt`.

```bash
pnpm add @super-line/core @super-line/collections-crdt-memory @super-line/collections-crdt-cloudflare
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { createDurableNode } from '@super-line/transport-cloudflare'
import { crdtCloudflareCollections } from '@super-line/collections-crdt-cloudflare'
import { contract } from './contract'

export class Node extends createDurableNode((ctx, env, base) =>
  createSuperLineServer(contract, {
    ...base,
    authenticate,
    policies,
    crdtCollections: crdtCloudflareCollections(ctx.storage, contract.collections),
  }),
) {}
```

Clients open documents with the universal `crdtCollectionsClient()` from `@super-line/collections-crdt-memory`, as with every backend.

`crdtCloudflareCollections(storage, collections, { debounceMs? })` is synchronous and takes the contract's `collections` map, so each document is rebuilt with its collection's `crdt` options. `clustering: 'relay'` — one node, so nothing is relayed.

## How it behaves

- **A document loads on first touch.** Nothing is read when the object wakes from hibernation, so a node with thousands of documents wakes as fast as one with none.
- **Edits reach storage `debounceMs` later** (250 ms by default). The pending write keeps the object awake until it lands, so hibernation never loses an edit; a deploy or a crash inside the window does.
- **A document is capped at 2 MB** of encoded state, the platform's row limit. `create` refuses a larger one, and once an edit grows a document past it, every later write to that document fails with an `INTERNAL` error naming it while storage keeps the last state that fit. Split large content across documents.
- **`list` reads storage**, so listing loads no documents and `createdAt` survives wakes.

- 📖 Guide: [Host a node on Cloudflare Durable Objects](https://super-line.dogar.biz/how-to/cloudflare-durable-objects)
- 📚 Reference: [Backends & clustering](https://super-line.dogar.biz/collections/backends)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
