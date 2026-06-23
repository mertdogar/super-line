# synced-canvas (Automerge)

The **same** collaborative canvas as [`../synced-canvas-yjs`](../synced-canvas-yjs), but backed by [Automerge](https://automerge.org) instead of Yjs. Same super-line contract, same UI — built as a side-by-side so you can feel the difference between the two CRDTs. (ADR-0001 picks Automerge for the OMMA Scene work; this is the playground.)

## What it demonstrates

The same four things the Yjs example does — **server↔client = client↔client**, a **CRDT-agnostic bus** (relays base64 blobs, never parses the doc), a **server co-writer** (`serverNudge`), and **server-side persistence** — plus the **contrasts** that decided ADR-0001:

| | Yjs | Automerge (this) |
| --- | --- | --- |
| Browser setup | pure JS, nothing extra | needs `vite-plugin-wasm` + `vite-plugin-top-level-await` (Rust→WASM core) |
| Doc model | mutable `Y.Doc` + `doc.on('update')` observer | **immutable** — every edit returns a *new* doc; the client threads it through a ref (`App.tsx`) |
| Authoring | `map.set(...)` | plain-JSON `change(doc, d => { d.shapes[id] = … })` |
| Wire payload | one opaque update | `getChanges()` deltas (an array) |
| Catch-up | apply state update | **`load` the server snapshot** — clients must never `A.from` (that forks history) |
| Debug panel patches | `observeDeep` events | native Automerge `Patch[]` from `patchCallback` |

Both also have a **debug side panel** mirroring the live JSON state and a capped log of recent patches, each tagged by origin (`local` / `peer` / `server`).

## Run

```bash
pnpm install   # from the repo root, once
pnpm --filter @super-line/example-synced-canvas-automerge dev
```

Open <http://localhost:5173> in **two windows**. Drag shapes, "Add shape", double-click to delete, "Server nudge". Reload a tab — state persists on the server.

## How it works

- The client holds a local Automerge doc in a **ref**. On mount it `joinDoc`s and `A.load`s the returned snapshot.
- Each local edit returns `[nextDoc, changes]`; the client swaps the ref and `pushChange`s the deltas.
- The server holds the canonical doc, `applyChanges` to it, persists (`A.save`), and re-broadcasts the changes to the room. Applying a change a peer already has is an idempotent no-op, so there's no echo loop and no origin-tagging needed.

> **Note** — for parity with the Yjs example this broadcasts `getChanges()` deltas, which is simple but assumes no client misses a message. A production build would use Automerge's **sync protocol** (`initSyncState` / `generateSyncMessage` / `receiveSyncMessage`) for gap-tolerant reconnects — that's the robust upgrade, at the cost of per-peer sync state on the server.
