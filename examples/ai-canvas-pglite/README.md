# ai-canvas-pglite

[`ai-canvas`](../ai-canvas) — a collaborative shape board with a **server-side AI agent as a first-class
co-writer** — but **re-clustered across nodes** on the [`@super-line/store-sync-pglite`](../../packages/store-sync-pglite)
**CRDT** store. Same UX: you drag shapes, you ask an agent ("add three blue circles in a row, then delete the
red one"), and its edits land on the **same board, in every tab, on every node**, merging with whatever
anyone is doing live. The difference from `ai-canvas`: that one runs on a single node; this one is a **2-node
cluster** whose CRDT convergence rides **Postgres + Electric**, not super-line's adapter.

## What it demonstrates

- **CRDT over Postgres + Electric, no adapter.** Every write appends an opaque **Yjs delta** to an append-only
  op-log in central Postgres; Electric streams the op-log to each node's in-memory PGlite replica, which folds
  the deltas into a super-store doc and fans them to its local tabs. Two nodes editing **different shapes
  merge** — concurrent INSERTs never clobber. This is genuine CRDT (`model: 'crdt'`), self-clustering
  (`clustering: 'self'`) — the store owns its cross-node sync; super-line's adapter is unused for it.
- **The server is a reactive co-writer.** The agent calls `srv.store('scene').open(SCENE_ID)` to get a
  `ServerReplica` over the canonical scene — `getSnapshot` reads the live in-memory Yjs doc synchronously,
  `update` merges, `delete(['shapes', id])` surgically removes. (`store-pglite`, the LWW sibling, can't do
  this — it has no in-memory doc; the CRDT op-log is what makes a synchronous `open()` possible here.)
- **Merge-safe concurrency, across nodes.** The scene is a `document`-mode CRDT, so you can drag a shape on
  node-1 while the agent edits *other* shapes on node-2 and neither clobbers the other.
- **The Control Center sees the whole cluster.** A broker-less **libp2p mesh** (peers found over mDNS, no extra
  container) carries presence + inspector so the Topology shows node-1 + node-2 + every connection. The store
  never touches it — it's a separate plane (Electric is invisible to the inspector; it syncs store data, not
  cluster metadata).
- **Degrades gracefully.** Without an API key the board is a fully working collaborative canvas; only the
  agent request returns a friendly error.

## Run

```bash
cp examples/ai-canvas-pglite/.env.example examples/ai-canvas-pglite/.env   # add your AI_GATEWAY_API_KEY
docker compose -f examples/ai-canvas-pglite/docker-compose.yml up --build
```

Then open **two** windows:

- <http://localhost:8200> — connected to **node-1**
- <http://localhost:8200/?node=2> — connected to **node-2**

Drag shapes, double-click to delete, ask the agent. Every edit appears in both windows: it crossed nodes
through Electric (the central Postgres op-log → each node's replica), not through any super-line adapter. Try
editing in both windows at once — different shapes merge instead of clobbering.

| Var | Meaning |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key — the only secret the agent needs. |
| `MODEL` | Any cheap tool-capable model, e.g. `anthropic/claude-haiku-4.5` or `google/gemini-3-flash`. |

### Control Center

The cluster also runs the [Control Center](../../packages/control-center) on **http://localhost:8201**. It
connects to node-1's inspector; because the nodes share a libp2p presence mesh, the **Topology shows the whole
cluster** — both nodes and every tab — plus the `scene` store and live `store.*` traffic. The agent's writes
are stamped `agent:N` (distinct from human edits) and visible here.

> A node with **zero connected clients is idle and invisible** in the topology (same as the Redis adapter —
> idle nodes don't broadcast presence). So node-2 only appears once a client connects to it: open the
> **`?node=2`** window and it joins the Topology. This is presence, not the store — the store syncs over
> Electric regardless of whether anyone is watching.

## How it works

| Piece | Role |
| --- | --- |
| `scene.ts` | Shared scene model (`{ shapes: { id → shape } }`) + `resolveOptions` (document mode) imported by **both** store halves so they can't drift. *(verbatim from `ai-canvas`)* |
| `contract.ts` | One request — `agentEdit`. The scene is off-contract; the Store syncs it. *(verbatim)* |
| `agent.ts` | One `generateText` turn (AI SDK + AI Gateway) with four tools mapping to Store primitives. *(verbatim)* |
| `App.tsx` | `useResource('scene','board')` via `syncStoreClient`; `?node=2` dials node-2. *(client unchanged — it already speaks CRDT)* |
| `server.ts` | Per-node: `syncPgliteStoreServer`, the libp2p-mDNS coordination plane, `agentEdit` opening a `ServerReplica`, and the shared-board seed. |

The client half is the **unchanged** `syncStoreClient` from `@super-line/store-sync` — `store-sync-pglite` ships
no client, because the wire (base64 Yjs deltas) is identical; only the *server's* cross-node transport changed
from the adapter relay to the Electric op-log.

## Notes

- The local PGlite replica is **in-memory** (ephemeral) — it re-folds the op-log from Electric on boot.
- Electric runs in `ELECTRIC_INSECURE` mode here for local dev only.
- **Compaction is on** (default): a debounced pass folds the op-log → writes a Yjs **baseline** row + materializes
  the folded board into `resources.data` → trims the superseded rows. So `SELECT data FROM resources WHERE
  id = 'board'` gives the live board without folding, and the op-log stays bounded. Tune via `compact: { everyNUpdates,
  debounceMs }` (or `compact: false` for a pure append-only log) on `syncPgliteStoreServer`.
- Peer discovery is **mDNS** (multicast on the shared network). Docker's compose bridge passes multicast; many
  cloud/k8s networks don't — there, swap `mdns()` for `bootstrap` to one pinned seed + `@libp2p/pubsub-peer-discovery`
  (see `examples/libp2p-nat`), still without hardcoding the cluster size.
