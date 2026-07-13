# ai-canvas

A collaborative shape board where a **server-side AI agent is a first-class co-writer**. You drag shapes;
you also ask an agent ("add three blue circles in a row, then delete the red one") and its edits land on the
**same board**, in **every tab**, merging with whatever you're doing live.

It's the visual cousin of [`synced-canvas-yjs`](../synced-canvas-yjs), rebuilt on a
[`@super-line/collections-crdt-memory`](../../packages/collections-crdt-memory) **CRDT document collection**
so it can showcase the reactive **server co-writer**: `srv.collection('scene').open(id) → CrdtServerReplica`.

## What it demonstrates

- **The server is a reactive co-writer.** The agent calls `srv.collection('scene').open(id)` to get a
  `CrdtServerReplica` over the canonical scene — it **reads** the live board (`getSnapshot`), **merges** edits
  (`update`), and **surgically removes** shapes (`delete(['shapes', id])`). No client, no loopback.
- **The canvas is the agent's output surface.** Each LLM tool maps to one document primitive, so the agent's
  tool calls *are* CRDT deltas that fan out to every tab — no bespoke streaming channel.
- **Merge-safe concurrency.** The scene is a `document`-mode CRDT collection (recursive CRDT), so you can keep
  dragging a shape while the agent edits *other* shapes and neither clobbers the other. `delete(path)` is
  the only key-removing op and is atomic in-process, so the agent's delete never wipes your concurrent edit.
- **Degrades gracefully.** Without an API key the board is still a fully working collaborative canvas; only
  the agent request returns a friendly error.

## Run

```bash
pnpm install                       # from the repo root, once
cp examples/ai-canvas/.env.example examples/ai-canvas/.env   # add your AI_GATEWAY_API_KEY
pnpm --filter @super-line/example-ai-canvas dev
```

Open <http://localhost:5373> in **two windows** (try `?name=ada` / `?name=bob`). Drag shapes, double-click to
delete, and type a prompt for the agent. It's also reachable from other devices on your Tailscale/LAN network
(both server and web bind `0.0.0.0`) — just browse to `http://<this-host>:5373`.

| Var | Meaning |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key — the only secret the agent needs. |
| `MODEL` | Any cheap tool-capable model, e.g. `anthropic/claude-haiku-4.5` or `google/gemini-3-flash`. |

## How it works

| Piece | Role |
| --- | --- |
| `scene.ts` | The shared scene schema (`{ shapes: { id → shape } }`), imported by `contract.ts` so the server validate-before-commits every write against it. |
| `contract.ts` | The scene is an **on-contract** CRDT document collection (`crdt: { mode: 'document' }`, ADR-0007) — typed and validated on every write — plus one request, `agentEdit`. |
| `server.ts` | Seeds the board (`srv.collection('scene').create`), grants read+write per connection, and on `agentEdit` opens a `CrdtServerReplica` (`srv.collection('scene').open(id, { origin: 'agent:N' })`), runs the agent, and `close()`s the handle. |
| `agent.ts` | One `generateText` turn (AI SDK + AI Gateway) with four tools — `add`/`move`/`recolor` → `replica.update`, `delete` → `replica.delete(path)` — bounded by `stopWhen: stepCountIs(8)`. |
| `App.tsx` | `useDoc('scene', SCENE_ID)` gives the live `data` + `update`/`delete`; drag/add/delete write through it, and the agent prompt box calls `agentEdit`. |

The `{ origin: 'agent:N' }` stamp on the agent's writes isn't surfaced in this UI, but it's visible
**server-side and in the [Control Center](https://super-line.dogar.biz/how-to/control-center)**: `plugins: [inspector()]`
is already wired in `server.ts`, so every edit streams to the live feed's **Collections** filter as `crdt.write`
rows — each stamped with its `origin` and expandable to the decoded post-merge snapshot, so you can tell the
agent's co-writes from human edits in real time.

> Extension: wire `replica.subscribe(...)` so a long agent turn reacts to the user's edits mid-turn — a free
> bonus of the reactive replica (deferred here to keep each turn simple).
