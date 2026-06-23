# synced-canvas (Yjs)

A tiny collaborative canvas: **synced JSON state over super-line, backed by a [Yjs](https://github.com/yjs/yjs) CRDT**. Multiple browser tabs edit the same board live; the server holds the canonical document, persists it, and can mutate it too.

## What it demonstrates

- **Server↔client and client↔client sync are the same mechanism.** Every client syncs to one canonical doc the server hubs — "between clients" is just "both clients sync through the server."
- **super-line stays CRDT-agnostic.** It relays opaque base64 update bytes per room (the `update` event) and never parses the document. The contract is identical whatever CRDT you plug in.
- **The server is a co-writer.** "Server nudge" mutates the doc server-side; clients see it merge in exactly like another user's edit.
- **Server-side persistence.** The document of record lives in an in-memory store on the server — swap it for a file/DB/Redis to survive a restart.
- **Z-order is a per-shape `order` field, not array position,** so concurrent reorders can't corrupt the list (see [`docs/adr/0001`](../../docs/adr/0001-automerge-over-yjs-for-synced-scene-state.md) — a CRDT-agnostic rule).
- **A debug side panel** mirrors the synced JSON state live and logs recent decoded patches (Yjs `observeDeep` events), each tagged by origin — `local` / `peer` / `server` — so you can literally watch the server's nudge land as a `server` patch.

## Run

```bash
pnpm install   # from the repo root, once
pnpm --filter @super-line/example-synced-canvas-yjs dev
```

Open <http://localhost:5173> in **two windows**. Drag shapes, "Add shape", double-click to delete, and hit "Server nudge". Reload a tab — state persists on the server.

## How it works

| Piece | Role |
| --- | --- |
| `crdt.ts` | The Yjs document model: shapes as a keyed `Y.Map`, with mutation helpers and a `useShapes` React hook. Pure Yjs — no super-line. |
| `contract.ts` | The super-line wire: `joinDoc` (catch-up snapshot), `pushUpdate` (client → server), `update` (server → clients). Carries base64 blobs only. |
| `server.ts` | The hub: holds the canonical `Y.Doc` per room, hydrates from the store, and uses the doc's own `update` observer as the single fan-out + persist point. |
| `App.tsx` | Holds a local `Y.Doc`, pushes local edits up (origin-tagged to avoid echo), applies fanned-out updates down, and renders the board. |

The echo-break: local edits carry no origin and get pushed; updates applied from the server are tagged `'remote'` and are skipped by the push listener.
