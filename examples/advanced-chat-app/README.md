# advanced-chat-app

A Slack-like chat app built on super-line — channels, message history, presence, typing
indicators and per-channel unread badges, with a Vite + React 19 + Tailwind v4 + shadcn/ui
front end (using the [shadcn-chat](https://shadcn-chat.vercel.app) blocks).

The headline: **channels and message history live in a `Store`, persisted to SQLite via
[`@super-line/store-sqlite`](../../packages/store-sqlite)** — so the workspace survives a server
restart and streams live to every connected client for free.

## Run it

```bash
pnpm install            # from the repo root (builds the better-sqlite3 native module)
pnpm --filter @super-line/example-advanced-chat-app dev
```

- web: http://localhost:5173 — enter a display name (or open `?name=ada`)
- server: `ws://localhost:8790`

Open a second window as a different user (`?name=bob`) to see live messages, presence and typing.
The workspace persists to `examples/advanced-chat-app/chat.db` (gitignored) — **stop and restart
the server and your channels + history are still there.** Delete `chat.db` to reset.

## How it works

**The store is the read-model; requests are the writes.** Channels and messages are *off-contract*
state held in one `chat` Store namespace:

- a `channels` Resource — the sidebar index (`{ channels: [{ id, name }] }`)
- one `messages:<channelId>` Resource per channel — that channel's array of messages

The server is the **sole writer**. Clients never mutate the store directly; they read it live with
`useResource('chat', id)` and write through normal contract requests:

| request | what the server does |
| --- | --- |
| `createChannel` | creates a `messages:<id>` Resource, then appends to the `channels` index (fans out to every sidebar) |
| `send` | appends a message to that channel's Resource (fans out to everyone viewing it) |
| `typing` | rebroadcasts an ephemeral, auto-expiring typing signal |
| `hello` | seeds the current presence list on connect (topics aren't retained) |

`presence` (who's online) and `typing` are ephemeral **topics** — they are *not* persisted, only the
durable channel/message Resources are.

**Persistence** is `@super-line/store-sqlite`'s `sqliteStoreServer({ file })` — a durable,
last-writer-wins `ServerStore` (the SQLite-backed peer of `@super-line/store-memory`). The client
pairs it with the in-memory `memoryStoreClient()`.

**Open-workspace access.** Stores are deny-by-default and the read ACL is checked once at open time,
so every connection is given the same `identify` principal (`'workspace'`) and every Resource is
created granting it read. One shared grant means every client's open succeeds — no per-connection
grant race.

**Unread badges** are derived entirely client-side: each sidebar row subscribes to its own channel's
Resource and counts messages newer than a per-channel "last read" marker kept in `localStorage`
(per-browser; not synced across devices).

## Files

- `src/contract.ts` — the wire contract (requests + presence/typing topics) and the store doc types
- `src/server.ts` — the super-line server: SQLite store, server-authoritative writes, presence/typing
- `src/components/` — the Slack UI (sidebar, channel view, composer, create-channel dialog)
- `src/components/ui/` — shadcn primitives + the shadcn-chat blocks
