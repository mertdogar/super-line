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
the same hooked domain cores (with `initiator.kind === 'server'`):

```ts
const ops = await chatKit.channels.create({ name: 'ops', visibility: 'private', owner: adminId })
await chatKit.members.add(ops.id, someUserId)
await chatKit.messages.send({ channelId: ops.id, authorId: botId, text: 'deploy done' })
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
