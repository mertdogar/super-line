# ai-canvas

A collaborative shape board where a **server-side AI agent is a first-class co-writer**. You drag shapes;
you also ask an agent ("add three blue circles in a row, then delete the red one") and its edits land on the
**same board**, in **every tab**, merging with whatever you're doing live.

It's the visual cousin of [`synced-canvas-yjs`](../synced-canvas-yjs), rebuilt on the
[`@super-line/store-sync`](../../packages/store-sync) CRDT Store so it can showcase the Store's
**reactive server co-writer**: `srv.store('scene').open(id) → ServerReplica`.

## What it demonstrates

- **The server is a reactive co-writer.** The agent calls `srv.store('scene').open(id)` to get a
  `ServerReplica` over the canonical scene — it **reads** the live board (`getSnapshot`), **merges** edits
  (`update`), and **surgically removes** shapes (`delete(['shapes', id])`). No client, no loopback.
- **The canvas is the agent's output surface.** Each LLM tool maps to one Store primitive, so the agent's
  tool calls *are* Store deltas that fan out to every tab — no bespoke streaming channel.
- **Merge-safe concurrency.** The scene is a `document`-mode Resource (recursive CRDT), so you can keep
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
| `scene.ts` | The shared scene model (`{ shapes: { id → shape } }`) + the `resolveOptions` (document mode) imported by **both** store halves so they can't drift. |
| `contract.ts` | The wire is just one request — `agentEdit`. The scene itself is off-contract; the Store syncs it. |
| `server.ts` | Seeds the board, grants read+write per connection, and on `agentEdit` opens a `ServerReplica` (`{ origin: 'agent:N' }`), runs the agent, and `close()`s the handle. |
| `agent.ts` | One `generateText` turn (AI SDK + AI Gateway) with four tools — `add`/`move`/`recolor` → `replica.update`, `delete` → `replica.delete(path)` — bounded by `stopWhen: stepCountIs(8)`. |
| `App.tsx` | `useResource('scene','board')` gives the live `data` + `update`/`delete`; drag/add/delete write through it, and the agent prompt box calls `agentEdit`. |

The `{ origin: 'agent:N' }` stamp on the agent's writes isn't surfaced in this UI, but it's visible
**server-side and in the Control Center**, where you can tell the agent's co-writes from human edits.

> Extension: wire `replica.subscribe(...)` so a long agent turn reacts to the user's edits mid-turn — a free
> bonus of the reactive replica (deferred here to keep each turn simple).
