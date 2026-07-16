# @super-line/plugin-chat

A reusable **chat backbone** for [**super-line**](https://super-line.dogar.biz/), as a paired plugin:
**channels** (public + private), owner/member **membership control**, and **messages** (send · edit ·
delete), all backed by typed [collections](https://super-line.dogar.biz/collections/). Every mutation is a
**server-authoritative, hookable request**, so ids and timestamps are trustworthy and a host can wrap any
operation. It ships an imperative server API and a ready-made AI-SDK toolset, so back-office code and LLM
agents drive the exact same model as browser clients.

Requires [`@super-line/plugin-auth`](https://www.npmjs.com/package/@super-line/plugin-auth) — identity and
principals come from it, and chat rows reference its `users` directory.

```bash
pnpm add @super-line/plugin-chat @super-line/plugin-auth
```

## Wire it in

```ts
// 1 · contract — merge both fragments. chatContract() adds the channels/memberships/messages
//     collections and the 11 mutation requests; the message body defaults to plain text.
import { defineContract } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

export const app = defineContract({ roles: { user: {} }, plugins: [authContract(), chatContract()] })
```

```ts
// 2 · server — register the kit's plugin (row policies + the 11 handlers) alongside auth's.
//     Wrap any operation with a domain hook — it fires for client requests AND server calls.
import { chat } from '@super-line/plugin-chat/server'

const chatKit = chat({
  contract: app,
  hooks: {
    sendMessage: {
      before: (input, initiator) => {           // transform (return) or veto (throw)
        if (initiator.kind === 'client' && isSpam(input.content)) throw new Error('no spam')
        return input
      },
      after: (message) => void audit(message),
    },
  },
})

createSuperLineServer(app, {
  collections: backend,
  authenticate: authKit.authenticate,
  identify: authKit.identify,                   // principal := userId — drives the chat read policies
  plugins: [authKit.plugin, chatKit.plugin],
})
```

```ts
// 3 · client — typed request methods + live stores. No React/TanStack dependency; agents use it too.
import { chatClient } from '@super-line/plugin-chat/client'

const chatCli = chatClient(client, { userId })
const ch = await chatCli.createChannel({ name: 'general', visibility: 'public' })
await chatCli.send(ch.id, 'hello')

const feed = chatCli.messages(ch.id)            // live, chronological, newest-N window
feed.subscribe(() => render(feed.rows()))       // re-subscribes itself when your membership changes
```

React bindings come from `@super-line/plugin-chat/react`:

```tsx
const { ChatProvider, useChat, useChannels, useMembers, useMessages } = createChatHooks<typeof app>()
```

## Requests-first, read-only collections

Unlike raw collections (direct, optimistic row-writes), this plugin makes **every mutation a request**: the
collections are declared **client-read-only** (membership-scoped `read` policies, `write` denied), and each
write flows through a server-authoritative handler. Underneath every operation sits one **domain core** the
request handler and the imperative kit both call, wrapped by your before/after **hooks** — one extension
seam that can't be bypassed. The trade-off (server authority + hookability, at the cost of optimism) is
recorded in [ADR-0010](https://github.com/mertdogar/super-line/blob/main/docs/adr/0010-plugin-domain-surfaces-are-requests-first-with-domain-hooks.md).

## The membership model

- **Channels** are `public` (anyone discovers + self-joins) or `private` (invisible to non-members; you are
  added by an owner, you can't join). Messages are membership-scoped in both cases.
- **Members** carry a role: `owner` or `member`. The creator is the first owner; owners manage membership,
  rename, and delete the channel; members chat and can always self-leave.
- **Last-owner protection**: leaving, being removed, or self-demoting throws `CONFLICT` if it would leave a
  channel with members but no owner.

## Server-side management + AI agents

`chatKit` exposes an imperative surface — running through the same hooked cores, with
`initiator.kind === 'server'` — so agents and back-office code drive the model directly:

```ts
const ops = await chatKit.channels.create({ name: 'ops', visibility: 'private', owner: adminId })
await chatKit.members.add(ops.id, someUserId)
await chatKit.messages.send({ channelId: ops.id, authorId: botId, content: 'deploy done' })
```

**AI agents are regular users** — provision one with [plugin-auth](https://www.npmjs.com/package/@super-line/plugin-auth)
(`authKit.users.create` + `authKit.apiKeys.create`), add it to a channel, and let it connect with the same
`chatClient`. To let an LLM *drive* chat, the `/ai` subpath ships a [Vercel AI SDK](https://ai-sdk.dev)
toolset over the agent's **own** connection — so the server authorization-checks every call and the model
can never exceed its bot's permissions:

```ts
import { ToolLoopAgent } from 'ai'
import { chatAgentTools } from '@super-line/plugin-chat/ai'

const agent = new ToolLoopAgent({ model, tools: chatAgentTools(client) })
// core: list_channels · list_members · read_messages · send_message · join_channel · leave_channel
// { management: true } adds channel lifecycle, membership control, edit/delete, and list_users
```

## Subpaths

`.` (contract fragment + schemas/types) · `/server` (`chat()` → `chatKit`) · `/client` (`chatClient`) ·
`/react` (`createChatHooks`) · `/ai` (`chatAgentTools`; `ai` is an optional peer dependency).

The message body is host-parametrized: `chatContract({ content })` slots your Zod schema into the `messages`
collection and the send/edit requests, so the server validates every body and types flow end-to-end
(default: plain text).

## Learn more

- **Guide:** <https://super-line.dogar.biz/how-to/plugin-chat>
- **Tutorial:** <https://super-line.dogar.biz/tutorials/chat-backbone>
- **Example:** [`examples/collections-chat`](https://github.com/mertdogar/super-line/tree/main/examples/collections-chat)
  — a Slack-like app built entirely on this plugin, with a live LLM agent in an `#ask-ai` channel.

MIT © super-line
