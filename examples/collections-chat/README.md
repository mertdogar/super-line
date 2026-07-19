# collections-chat

A Slack-like chat app built entirely on **[`@super-line/plugin-chat`](../../packages/plugin-chat)** — the
chat backbone plugin — with identity from **[`@super-line/plugin-auth`](../../packages/plugin-auth)** and a
live **LLM agent** you can talk to. Channels, membership control, and messages are typed collections the
plugin owns; this app is mostly UI plus a little presence/typing garnish.

A Vite + React 19 + Tailwind v4 + shadcn/ui front end (the [shadcn-chat](https://shadcn-chat.vercel.app)
blocks). Durable to `collections-chat.db` (gitignored, [`@super-line/collections-sqlite`](../../packages/collections-sqlite)).

**The headline:** the whole chat model — public/private channels, owner/member roles, send/edit/delete —
comes from the plugin. The app declares only the ephemeral presence/typing signals, proving host-land
garnish still composes on a plugin backbone.

```ts
// the entire durable model is two plugins on the contract
plugins: [authContract(), chatContract()]
// → collections: users, credentials, sessions, channels, memberships, messages
// → requests:     signIn/signUp/…, createChannel/join/addMember/sendMessage/editMessage/…
```

## Run it

```bash
pnpm install            # from the repo root (builds the better-sqlite3 native module)
pnpm --filter @super-line/example-collections-chat dev
```

- web: http://localhost:5173 — sign up with an email + password (identity is real, via plugin-auth)
- server: `ws://localhost:8791`

Open a second window as a different user to see live messages, presence, and typing. The workspace
persists — restart the server and your channels, memberships, and history are still there. Delete
`collections-chat.db` to reset.

### Talk to the AI agent

Every new user is dropped into **#ask-ai**, where a bot named **Ask AI** replies. The bot is a *genuine
user*: the server provisions it (`authKit.users.create` + `authKit.apiKeys.create`) and runs it as a
headless client connecting over WebSocket with its own API key — its messages are ordinary wire traffic
you can watch in the Control Center.

By default it replies with canned offline messages (no setup needed). To give it a real brain, copy
`.env.example` to `.env` and add a [Vercel AI Gateway](https://vercel.com/ai-gateway) key:

```bash
# examples/collections-chat/.env
AI_GATEWAY_API_KEY=your_key
# MODEL=anthropic/claude-sonnet-5   # optional; any Gateway "provider/model" string
```

The agent uses the [Vercel AI SDK](https://ai-sdk.dev) — swap providers by changing the `MODEL` string.

### Try the membership control

- **Public vs private.** Create a channel and pick **Public** (anyone finds + joins) or **Private**
  (invisible to non-members; you're added by an owner). A private channel you don't belong to never appears
  and its messages never cross the wire.
- **Roles.** The creator is the **owner**. Open the **Members** panel — as an owner you can add people,
  remove them, and promote/demote between owner and member. Try to remove the last owner and the server
  refuses with a conflict.
- **Edit / delete.** Hover your own messages to edit or delete them (author-only, enforced server-side).
- Every action is a **server-authoritative request** — tamper with the client and you just get `FORBIDDEN`.

### Inspect live traffic (Control Center)

```bash
pnpm --filter @super-line/example-collections-chat inspector
```

Builds the [Control Center](../../packages/control-center), serves it on http://localhost:7777, and points
it at this server. Open **Collections** for the `users ← messages → channels ← memberships` schema graph,
and the **live feed** to watch the chat requests + `cchg` frames as you (and the agent) chat.

## How it works

**The plugin owns the durable model; the app owns the UI and the garnish.**

- **Identity** — plugin-auth. Sign-up/login, sessions, the `users` directory; `identify()` returns your
  `userId`, the principal plugin-chat's read policies key on.
- **The chat model** — plugin-chat. Its `chatKit.plugin` ships the row policies (read = membership-scoped
  RLS; write = deny) and the 20 request handlers. This app has **no** channel/message policies or handlers
  of its own — see [`src/server.ts`](src/server.ts).
- **Every mutation is a request**, not an optimistic row-write ([ADR-0010](../../docs/adr/0010-plugin-domain-surfaces-are-requests-first-with-domain-hooks.md)).
  The server owns ids and timestamps, and a `sendMessage` **hook** trims + rejects empty bodies for humans
  and the agent alike.
- **The client is `chatClient`** ([`src/lib/chat.tsx`](src/lib/chat.tsx)) — no TanStack dependency. It owns
  the re-subscribe-on-membership-change mechanic, so joining a channel streams its backlog into an already-
  open store with no manual wiring. React bindings (`useChannels`/`useMembers`/`useMessages`) come from
  `@super-line/plugin-chat/react`; the app reads the world-readable `users` directory directly for author
  names.
- **The agent** ([`src/agent.ts`](src/agent.ts)) is the same `chatClient` a human uses — the plugin has one
  client surface for browsers and headless agents alike.
- **Token usage as typed data parts (0.6.0)** — `chatContract({ data: usageDataSchema })` types the agent's
  durable data parts; the AI SDK's `messageMetadata` rides the finish event as a framing chunk, `mapDataPart`
  turns it into a `usage` part, and the transcript renders it as a token chip. The `content`/`data` slots
  accept **any Standard Schema validator** — your zod version doesn't have to match plugin-chat's
  ([ADR-0013](../../docs/adr/0013-plugin-chat-host-schemas-bridge-through-standard-schema.md)).
- **Empty turns are one `deleteMessage`** — deleting a still-streaming message settles it first
  server-side ([ADR-0014](../../docs/adr/0014-a-streamed-message-always-settles-before-it-vanishes.md)),
  so the old abort-then-delete recipe is gone, and `useChannelBusy` gives the "Ask AI is responding…"
  signal without a hand-rolled status scan.
