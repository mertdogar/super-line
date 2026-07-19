# Chat backbone — `@super-line/plugin-chat`

A reusable chat model as a **paired plugin**: **channels** (public + private), **membership control**
(owner/member roles), and **messages** (send · edit · delete · stream), all backed by typed
[collections](/collections/) and every mutation server-authoritative and **hookable**. It builds on
[`@super-line/plugin-auth`](/how-to/plugin-auth) — a hard prerequisite, since chat rows reference the
`users` directory and every action is keyed on the signed-in user.

```bash
pnpm add @super-line/plugin-chat @super-line/plugin-auth
```

Unlike the raw [collections](/collections/) approach (direct, optimistic row-writes), this plugin makes
**every mutation a request** handled server-side, so ids and timestamps are authoritative and a host can
wrap any operation with a hook. That trade-off is recorded in
[ADR-0010](https://github.com/mertdogar/super-line/blob/main/docs/adr/0010-plugin-domain-surfaces-are-requests-first-with-domain-hooks.md).

This page is the **core model** — wire it in, its membership rules, and the imperative server surface.
Companion guides go deeper:

- **[Migrate from 0.4 to 0.5](/how-to/plugin-chat-0-5-migration)** — update assembled feeds, bot
  helpers, stream events, AI SDK imports, and Mastra integration.
- **[Stream an agent's turn](/how-to/chat-streaming)** — streamed messages: one message that opens
  empty, accumulates typed parts (text · reasoning · tool calls · subagent trees) live, and settles.
- **[Run an AI chat bot](/how-to/chat-bots)** — provision a bot user, run its message loop, and give
  it a permission-checked AI SDK or Mastra brain.
- **[Attach channel resources](/how-to/chat-resources)** — link host-declared CRDT docs (canvases,
  todo lists…) to channels: membership-gated collaboration for every member, humans and agents alike.

::: tip New here? Build it first
[Tutorial 4 · Assemble a chat backbone](/tutorials/chat-backbone) stands the whole thing up in one
runnable file. This page is the reference you reach for afterwards.
:::

## Wire it in

### 1 · Contract

`chatContract()` merges six collections (`channels` / `memberships` / `messages` / `messageParts` /
`resources` / `resourcePresence`) and the 20 mutation requests into your contract. It sits alongside `authContract()`.

```ts
import { defineContract } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

export const app = defineContract({
  roles: { user: {} },
  plugins: [authContract(), chatContract()],
})
```

The message **body is yours to shape**. `chatContract()` defaults to plain text (`z.string()`); pass a
schema to make messages structured — the server validates every body and the type flows end-to-end:

```ts
const content = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), url: z.string(), alt: z.string() }),
])
plugins: [authContract(), chatContract({ content })]
```

::: warning Structured bodies + streaming
If you pass a `content` schema **and** stream messages, you must also give the server a
`chat({ streaming: { project } })` so it can derive the settled body from the final parts — the default
text-join only fits `z.string()`. See [Stream an agent's turn](/how-to/chat-streaming#structured-content).
:::

### 2 · Server

`chat({ contract, hooks? })` returns `chatKit`. Register `chatKit.plugin` — it ships the row policies
(read = membership-scoped RLS; write = deny, so collections are a read-only sync surface) and the 20
request handlers. Everything else is subtracted from your `implement()`.

```ts
import { chat } from '@super-line/plugin-chat/server'

const chatKit = chat({
  contract: app,
  hooks: {
    // fires for client requests AND imperative chatKit calls — one un-bypassable extension point
    sendMessage: {
      before: (input, initiator) => {
        if (initiator.kind === 'client' && isSpam(input.content)) throw new SuperLineError('FORBIDDEN', 'no spam')
        return input // may transform (return a new input) or veto (throw)
      },
      after: (message) => void audit(message),
    },
  },
})

createSuperLineServer(app, {
  collections: backend,
  authenticate: authKit.authenticate,
  identify: authKit.identify, // principal := userId — drives the chat read policies
  plugins: [authKit.plugin, chatKit.plugin],
})
```

### 3 · Client

`chatClient(client)` gives typed request methods plus live stores. It owns the **re-subscribe mechanic**:
server read filters are captured at subscribe time, so when your membership changes the stores tear down
and re-open automatically — you never see it. It has **no React or TanStack dependency**, so a headless
agent uses the exact same API.

```ts
import { chatClient } from '@super-line/plugin-chat/client'

const chat = chatClient(client, { userId })
const channel = await chat.createChannel({ name: 'general', visibility: 'public' })
await chat.send(channel.id, 'hello')

const feed = chat.messages(channel.id, { limit: 200 }) // live, chronological, newest-N window
feed.subscribe(() => render(feed.rows()))
```

Await `chat.ready` before you depend on live delivery — it resolves once the client's own user id is
known and its membership watcher is armed. Pass `userId` if you already have it (from
[`authClient`](/how-to/plugin-auth)), or omit it to let the client resolve it with a `whoami` round-trip.

React bindings come from `@super-line/plugin-chat/react`:

```tsx
const { ChatProvider, useChat, useChannels, useMembers, useMessages } = createChatHooks<typeof app>()
// <ChatProvider chat={chatClient(client, { userId })}> … </ChatProvider>
const messages = useMessages(channelId)
```

Each hook owns its store's lifecycle (closed on unmount / channel switch); the re-subscribe-on-membership
dance lives in the client, not the hook. Rebuild the `chatClient` (and remount `ChatProvider`) whenever
the auth client swaps connections — one `chatClient` wraps exactly one connected client.

## The membership model

- **Channels** are `public` (anyone discovers + self-joins) or `private` (invisible to non-members; you
  are added by an owner, you can't join). Messages are membership-scoped in both cases — a private
  channel's messages never cross the wire to a non-member, and probing a private id answers `NOT_FOUND`
  so its existence can't be confirmed.
- **Members** carry a role: `owner` or `member`. The creator is the first owner. Owners manage membership
  (`addMember` / `removeMember` / `setMemberRole`), rename, and delete the channel; members chat and can
  always self-leave.
- **Last-owner protection**: leaving, being removed, or self-demoting throws `CONFLICT` if it would leave a
  channel with members but no owner — promote someone first, or delete the channel.
- **Write rule**: sending/editing requires membership, and editing or deleting a message requires being
  its **author** (`author ∧ member`). The server enforces all of it at the source, so tampering with a
  client just earns a `FORBIDDEN`.

Removing a member **disconnects** their live connections (captured read filters only re-evaluate on
re-subscribe, so the client reconnects and re-subscribes against the new membership state); a self-leave
does not disconnect but stops the ex-member from receiving the channel's traffic.

## Server-side management — the imperative `chatKit`

`chatKit` exposes an imperative surface for server code — channels, members, messages, and channel
resources — running through the same hooked domain cores (with `initiator.kind === 'server'`), so a server
write trips the same hooks as a client one. It's live only **after** you pass `chatKit.plugin` to
`createSuperLineServer` (it captures the running server's co-writer at setup); call it before that and it
throws with guidance.

```ts
// chatKit.channels
chatKit.channels.create({ name, visibility?, owner?, metadata? }) // owner → owner-membership written atomically
chatKit.channels.get(id)                                          // → ChatChannel | undefined
chatKit.channels.find({ filter?, limit?, offset? })              // → ChatChannel[]
chatKit.channels.update(id, { name?, metadata? })
chatKit.channels.delete(id)                                       // cascades memberships + messages + parts + resources (owned docs deleted)

// chatKit.members
chatKit.members.add(channelId, userId, { role?, metadata? })
chatKit.members.remove(channelId, userId)
chatKit.members.setRole(channelId, userId, role)
chatKit.members.of(channelId)                                     // → ChatMembership[]
chatKit.members.channelsOf(userId)                               // → ChatMembership[]

// chatKit.messages
chatKit.messages.send({ channelId, authorId, content, metadata? })
chatKit.messages.edit(id, { content?, metadata? })               // stamps editedAt
chatKit.messages.delete(id)                                       // hard-delete (+ its parts)
chatKit.messages.find({ filter?, orderBy?, limit?, offset? })    // → ChatMessage[]
// streaming surface — see the streaming guide:
chatKit.messages.stream({ channelId, authorId, metadata? })      // → ChatStreamWriter
chatKit.messages.abort(id, error?)                               // runtime kill-switch
chatKit.messages.partsOf(messageId)                             // idx-ordered parts
chatKit.messages.sweepStale({ olderThanMs })                    // repair crashed-node orphans

// chatKit.resources — see /how-to/chat-resources for the full model
chatKit.resources.create({ channelId, kind, title?, id?, params? }) // create-or-attach → ChatResource
chatKit.resources.detach(channelId, kind, docId)                  // → ChatResource; owned kinds delete the doc too
chatKit.resources.of(channelId)                                   // → ChatResource[] — the channel's registry rows
chatKit.resources.sweepPresence({ olderThanMs })                 // reap stale who's-open presence rows, → count
```

A quick tour — create a private channel, staff it, post to it:

```ts
const ops = await chatKit.channels.create({ name: 'ops', visibility: 'private', owner: adminId })
await chatKit.members.add(ops.id, someUserId)
await chatKit.messages.send({ channelId: ops.id, authorId: botId, content: 'deploy done' })
```

`messages.send` requires the `authorId` to already be a **member** — provision agents (a passwordless
user + API key) and add them to the channel first. That's the foundation the
[AI-bot guide](/how-to/chat-bots) builds on.

`chatKit.resources` is server-initiated the same way: no membership check and no resource card in the
feed. [`examples/chat-supervisor`](https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor)
uses `of` + `create` to auto-seed every channel with a canvas and a doc as soon as it appears:

```ts
const existing = await chatKit.resources.of(channelId)
for (const kind of ['canvas', 'doc'] as const) {
  if (!existing.some((r) => r.kind === kind))
    await chatKit.resources.create({ channelId, kind, title: kind === 'canvas' ? 'Canvas' : 'Doc' })
}
```

See [Attach channel resources](/how-to/chat-resources) for the registry model, lifecycles
(`owned` / `linked`), and the membership-gated policies registering a kind contributes.

## Hooks — the one extension point

Every domain operation has a before/after pair. `before` may **transform** (return a new input) or
**veto** (throw — nothing is written); `after` observes the committed result. They fire identically for a
browser request and an imperative `chatKit` call, distinguished only by the `initiator` argument
(`{ kind: 'client', userId }` vs `{ kind: 'server' }`) — one seam a host can never forget to call.

```ts
hooks: {
  createChannel: { before: (input, initiator) => ({ ...input, name: input.name.trim() }) },
  sendMessage:   { after:  (message, initiator) => void metrics.count('chat.sent') },
  removeMember:  { after:  (membership) => void audit('kicked', membership.userId) },
}
```

Hookable operations: `createChannel` · `updateChannel` · `deleteChannel` · `joinChannel` ·
`leaveChannel` · `addMember` · `removeMember` · `setMemberRole` · `sendMessage` · `editMessage` ·
`deleteMessage` · `startMessage` (gates who may open a stream) · `finalizeMessage` (fires on every
settle — the moderation/audit point for streamed turns) · `createResource` · `detachResource` ·
`writeResource` (the content-moderation point for the acked doc-write path). Stream **appends** are
hook-free by design.

## Where to go next

- **[Stream an agent's turn](/how-to/chat-streaming)** — the streaming message model end to end.
- **[Run an AI chat bot](/how-to/chat-bots)** — a live agent participant, permission-checked.
- **[`examples/collections-chat`](https://github.com/mertdogar/super-line/tree/main/examples/collections-chat)**
  — a Slack-like app built entirely on this plugin, with membership control, presence/typing garnish, and
  a live AI agent in an `#ask-ai` channel.
