# Chat backbone — `@super-line/plugin-chat`

A reusable chat model as a **paired plugin**: **channels** (public + private), **membership control**
(owner/member roles), and **messages** (send · edit · delete), all backed by typed
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

## Wire it in

### 1 · Contract

`chatContract()` merges three collections (`channels` / `memberships` / `messages`) and the 11 mutation
requests into your contract. It sits alongside `authContract()`.

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

### 2 · Server

`chat({ contract, hooks? })` returns `chatKit`. Register `chatKit.plugin` — it ships the row policies
(read = membership-scoped RLS; write = deny, so collections are a read-only sync surface) and the 11
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

React bindings come from `@super-line/plugin-chat/react`:

```tsx
const { ChatProvider, useChat, useChannels, useMembers, useMessages } = createChatHooks<typeof app>()
// <ChatProvider chat={chatClient(client, { userId })}> … </ChatProvider>
const messages = useMessages(channelId)
```

## The membership model

- **Channels** are `public` (anyone discovers + self-joins) or `private` (invisible to non-members; you
  are added by an owner, you can't join). Messages are membership-scoped in both cases.
- **Members** carry a role: `owner` or `member`. The creator is the first owner. Owners manage membership
  (`addMember` / `removeMember` / `setMemberRole`), rename, and delete the channel; members chat and can
  always self-leave.
- **Last-owner protection**: leaving, being removed, or self-demoting throws `CONFLICT` if it would leave a
  channel with members but no owner — promote someone first, or delete the channel.

## Server-side management + AI agents

`chatKit` exposes an imperative surface for server code — channels, members, and messages — running through
the same hooked domain cores (with `initiator.kind === 'server'`), so a server write trips the same hooks as
a client one:

```ts
// chatKit.channels
chatKit.channels.create({ name, visibility?, owner?, metadata? }) // owner → owner-membership written atomically
chatKit.channels.get(id)                                          // → ChatChannel | undefined
chatKit.channels.find({ filter?, limit?, offset? })              // → ChatChannel[]
chatKit.channels.update(id, { name?, metadata? })
chatKit.channels.delete(id)                                       // cascades memberships + messages

// chatKit.members
chatKit.members.add(channelId, userId, { role?, metadata? })
chatKit.members.remove(channelId, userId)
chatKit.members.setRole(channelId, userId, role)
chatKit.members.of(channelId)                                     // → ChatMembership[]
chatKit.members.channelsOf(userId)                               // → ChatMembership[]

// chatKit.messages
chatKit.messages.send({ channelId, authorId, content, metadata? })
chatKit.messages.edit(id, { content?, metadata? })               // stamps editedAt
chatKit.messages.delete(id)                                       // hard-delete
chatKit.messages.find({ filter?, orderBy?, limit?, offset? })    // → ChatMessage[]
```

A quick tour — create a private channel, staff it, post to it:

```ts
const ops = await chatKit.channels.create({ name: 'ops', visibility: 'private', owner: adminId })
await chatKit.members.add(ops.id, someUserId)
await chatKit.messages.send({ channelId: ops.id, authorId: botId, content: 'deploy done' })
```

**AI agents are regular users.** Provision one with [plugin-auth](/how-to/plugin-auth)'s server API — a
passwordless user plus an API key — then let it connect with the same `chatClient` over the real wire:

```ts
const bot = await authKit.users.create({ email: 'bot@app.dev', displayName: 'Ask AI' })
const { key } = await authKit.apiKeys.create(bot.id, { role: 'user', label: 'agent' })
await chatKit.members.add(channelId, bot.id)
// elsewhere: createSuperLineClient(app, { …, params: { apiKey: key } }) + chatClient(...) → the bot chats
```

The [`examples/collections-chat`](https://github.com/mertdogar/super-line/tree/main/examples/collections-chat)
app is built entirely on this plugin and ships a live LLM agent (via the Vercel AI Gateway) in an
`#ask-ai` channel, so you can watch a human and an agent talk over one contract.

## AI SDK toolset — `@super-line/plugin-chat/ai`

Give a [Vercel AI SDK](https://ai-sdk.dev) agent hands in the workspace: `chatAgentTools(client)` returns
a plain `ToolSet` over the agent's **own connection** — so every tool call is authorization-checked by the
server. RLS scopes `list_channels`/`read_messages` to what the bot can see, `send_message` requires
membership, and management needs ownership: **the model can never exceed its bot user's permissions.**
(`ai` is an optional peer dependency, like `react`.)

```ts
import { ToolLoopAgent } from 'ai'
import { chatAgentTools } from '@super-line/plugin-chat/ai'

const agent = new ToolLoopAgent({
  model: 'anthropic/claude-sonnet-5',
  instructions: 'You are a helpful assistant in this workspace.',
  tools: chatAgentTools(client), // the bot's OWN authenticated connection
})
```

- **Core set** (default): `list_channels` (with a member flag) · `list_members` · `read_messages`
  (author names resolved, ISO timestamps) · `send_message` · `join_channel` · `leave_channel`.
- **`{ management: true }`** adds channel lifecycle (`create_channel`/`update_channel`/`delete_channel`),
  membership control (`add_member`/`remove_member`/`set_member_role`), `edit_message`/`delete_message`,
  and `list_users` (directory search).
- **Failures come back structured** — `{ error: 'FORBIDDEN', message }` instead of a throw, so the model
  reads the denial and adapts ("I'm not a member; I should join first") rather than aborting the loop.
- The message body follows your contract: `chatAgentTools(client, { content })` slots the same schema you
  gave `chatContract({ content })` into `send_message`, so the model fills structured bodies.
- It's a plain record — spread-omit tools you don't want: the example agent drops `send_message` and lets
  its runtime own the posting, keeping the LLM read-only.
- **Stateless** — each read is a one-shot subscribe→snapshot→close, each write is one of the plugin's typed
  requests, so there's no lifecycle to manage and nothing to close.
