# collections-chat

A Slack-like chat app built on super-line **Collections** (ADR-0006) — the relational successor to the
LWW document [Store](../../packages/store-memory). Channels, memberships, users and message history are
**typed rows declared on the contract**, and the client uses [TanStack DB](https://tanstack.com/db) as its
query engine for the `messages ⋈ users` join and optimistic writes. A Vite + React 19 + Tailwind v4 +
shadcn/ui front end (the [shadcn-chat](https://shadcn-chat.vercel.app) blocks).

This is the collections counterpart to [`advanced-chat-app`](../advanced-chat-app) (same UI, built on the
durable `store-sqlite`). Read them side by side to see the two models.

**The headline:** super-line is the server-authoritative **sync source**; TanStack DB is the client
**query engine**. Four collections model the whole app, and **row-level security** is enforced
server-side — you only ever read messages in channels you've joined, and you can only post as yourself.

```ts
// on the contract — the server validates every row and types flow end-to-end
collections: {
  users:       { schema: { id, name },                          key: 'id' },
  channels:    { schema: { id, name, createdAt },               key: 'id' },
  memberships: { schema: { id, userId, channelId },             key: 'id', references: { userId: 'users', channelId: 'channels' } },
  messages:    { schema: { id, channelId, authorId, text, createdAt }, key: 'id', references: { authorId: 'users', channelId: 'channels' } },
}
```

## Run it

```bash
pnpm install            # from the repo root (builds the better-sqlite3 native module)
pnpm --filter @super-line/example-collections-chat dev
```

- web: http://localhost:5173 — enter a display name (or open `?name=ada`)
- server: `ws://localhost:8791`

Open a second window as a different user (`?name=bob`) to see live messages, presence and typing. The
workspace persists to `examples/collections-chat/collections-chat.db` (gitignored,
[`@super-line/collections-sqlite`](../../packages/collections-sqlite)) — **stop and restart the server and
your channels, memberships + history are still there.** Delete `collections-chat.db` to reset.

### Try the row-level security

- Every channel is listed in the sidebar (the `channels` collection is world-readable), but the ones you
  haven't joined show a **🔒 lock** — click one and you get a *"Join to see the conversation"* gate. Its
  messages never crossed the wire.
- **Join** it and the backlog streams in; **leave** and it vanishes. This is enforced by the server, not
  the UI — watch it in the Control Center.
- Posting a message is **optimistic** (it appears instantly). The author-only + member-only write policy
  means you can't post as someone else or into a channel you haven't joined — an illegal write rolls back.

### Inspect live traffic (Control Center)

The server enables the inspector (`plugins: [inspector()]`), so you can watch every request, response,
event and collection change in real time — and browse the collection schema graph + rows — with the
[Control Center](../../packages/control-center):

```bash
pnpm --filter @super-line/example-collections-chat inspector
```

It builds the Control Center, serves it on http://localhost:7777 and opens it pointed at this server
(`ws://localhost:8791`). Open the **Collections** view to see the `users ← messages → channels ← memberships`
schema graph and browse rows; open the **live feed** to watch `csub`/`cbat`/`cchg` frames as you chat.

## How it works

**Collections replace the Store as the durable read-model, and clients write rows directly.** There are no
`send`/`createChannel` request handlers — the server is just **row policies** + a couple of seed co-writes.

- **Identity.** Your display name maps to a stable `userId` (`slug(name)`), so your messages and
  memberships stick to you across reloads. The server upserts your `users` row and auto-joins `#general`
  on connect. `identify()` returns your `userId` — the principal every policy checks.
- **Writes are optimistic collection mutations.** Sending a message, creating a channel, and join/leave are
  all TanStack DB row writes (`messages.insert(...)`, `memberships.insert(...)`), mapped to atomic
  super-line batches by the [`@super-line/tanstack-db`](../../packages/tanstack-db) adapter. The server
  authorizes each with a **write policy** and rolls back the optimistic row on denial.
- **Reads are row-level-secured.** `messages.read = async (p) => isIn('channelId', await memberChannels(p))`
  — a policy that itself **queries the memberships collection**. It's ANDed into every snapshot *and* every
  live change, server-side.
- **The client join is TanStack DB.** `useLiveQuery` joins the synced `messages` collection with `users` to
  denormalize the author's name onto each message — the join runs on the client, over server-secured data.

### How RLS re-subscribes on join (the one subtle bit)

A read policy is evaluated at **subscribe time** and cached per connection, so it can go stale when your
membership changes. The client handles this without any manual re-subscribe wiring:

1. Join/leave write the `memberships` collection **non-optimistically** — the row appears only once the
   server confirms it.
2. `myChannelIds` is derived from those *confirmed* rows, so it only moves after the server agrees.
3. The `messages` collection is filtered by `myChannelIds`; when that set changes, the collection is
   re-created — a fresh subscription that makes the server re-evaluate the policy against your new
   membership. The just-joined channel's backlog streams in; a left channel's rows drop out.

The server independently enforces the same policy, so the client filter is only what *drives* the
re-subscribe — never what secures the data.

**Presence and typing stay ephemeral topics** (they aren't rows) — the durable/ephemeral split is explicit:
collections for state, topics for signals.

## Files

- `src/contract.ts` — the four collections + the ephemeral presence/typing topics
- `src/server.ts` — the super-line server: `collections-sqlite`, row-level-security `policies`, seed co-writes
- `src/lib/chat.tsx` — the TanStack DB collections + the `useChat()` provider (writes + the RLS re-subscribe)
- `src/lib/identity.ts` — `slug`/`memId`, shared by server + browser so both compute the same ids
- `src/components/` — the Slack UI (sidebar directory, channel view + join gate, composer, create-channel dialog)
- `src/components/ui/` — shadcn primitives + the shadcn-chat blocks
