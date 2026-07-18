# chat-resources — channel resource mechanics, headless

A single `tsx` script that exercises `@super-line/plugin-chat`'s **channel resources**
(PLAN-chat-resources) with no UI at all: a human client and a bot client attach CRDT documents to a
channel, write to them through both the live `DocHandle` and the acked `write_resource` tool path,
watch presence, and see the owned/linked lifecycle split on channel delete. It's the scriptable
companion to [chat-supervisor](../chat-supervisor) — same resource mechanics, none of the canvas,
Mastra, or terminal cockpit.

What it demonstrates:

- **Two resource kinds** registered via `chatKit.resources.kinds` — an **owned** `todo` (minted by
  chat, cascade-deleted with its channel) and a **linked** `canvas` (a host-meaningful doc id,
  survives channel deletion).
- **Two write paths onto the same doc** — Alice edits live through `collection('todos').open(...)`
  (optimistic `DocHandle`), the bot writes through the ACKED `write_resource` tool
  (`chatAgentTools`), and both converge on one CRDT document.
- **An honest rejection.** The bot's second write violates the canvas schema and comes back
  `VALIDATION` instead of silently corrupting the doc.
- **Presence and cascade.** `announceResource`/`resourcePresence` show who has a doc open; deleting
  the channel proves the todo doc is gone but the linked canvas survives.

## Run it

```bash
pnpm install     # repo root
cd examples/chat-resources
pnpm start
```

Everything runs in-process against an in-memory server (`collections-memory` +
`collections-crdt-memory`) — no Docker, no network. Read the console output top to bottom; each
line is annotated with which actor (`[alice]`/`[bot]`/`[presence]`/`[cascade]`) produced it.

Full write-up: [Channel resources](https://super-line.dogar.biz/how-to/chat-resources).
