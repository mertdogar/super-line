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

`chatContract()` merges three collections (`channels` / `memberships` / `messages`) and the 16 mutation
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
(read = membership-scoped RLS; write = deny, so collections are a read-only sync surface) and the 16
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

## Streaming messages — an agent's whole turn in one message

A message can be **streamed**: opened empty, appended to live, settled at the end — and it stores
the *entire* turn as typed **parts** (`text` · `reasoning` · `tool` calls with args/result/state),
including **subagent trees** (a part may nest under a delegate tool call via `parent`). Viewers see
token-smooth text (ephemeral per-channel deltas) on top of a durable floor: the in-flight part's
row checkpoints ~1s, so late joiners, reloads, and crashes always reconstruct the turn so far.
Decision record: [ADR-0011](https://github.com/mertdogar/super-line/blob/main/docs/adr/0011-streamed-messages-are-parts-rows-plus-ephemeral-deltas.md).

```ts
// producer (client or chatKit.messages.stream — same writer shape)
const w = await chat.stream(channelId)
try {
  w.push({ type: 'part_start', key: 't', partType: 'text' })
  w.push({ type: 'delta', key: 't', text: 'Hello ' }, { type: 'delta', key: 't', text: 'world' })
  w.push({ type: 'part_end', key: 't' })
  await w.finalize() // derives the plain `content` projection; hooks fire (start/finalize only)
} finally {
  await w.abort().catch(() => {}) // no-op if already settled; never leave a stream open
}
```

Consumers do nothing: the same `chat.messages(channelId)` feed serves streamed messages
**assembled** — `msg.parts` (tree-ordered, live text already spliced) and `msg.status`
(`streaming → complete | aborted | error`); plain messages are untouched. Render with one branch:
`msg.parts ? <AgentTurn/> : <Bubble/>`.

**Supervisor trees:** a part may nest under a delegate tool call via `parent`, so one message can
carry a whole multi-agent turn — each delegation rendering as its own card with the subagent's
tool calls and text inside, durable across reloads. You never build these trees by hand for
Mastra agents: `mastraEngine` (see the Mastra section below) owns the lanes, the
delegate tool, and the nesting; the
[`examples/chat-supervisor`](https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor)
app rebuilds super-harness's supervisor/worker flow with it in a handful of lines.

Worth knowing:

- **Lifetime**: the author's disconnect auto-aborts its open streams, partials preserved;
  `chatKit.messages.abort(id)` is the server-side kill-switch; `sweepStale` repairs crashed-node
  orphans (host-invoked). Graceful `server.close()` drains open streams.
- **Structured content hosts** (`chatContract({ content })` beyond a string) must supply
  `chat({ streaming: { project } })` to derive the settled `content` from the final parts — the
  default text-join fails loudly with guidance.
- **Caps** (`maxParts`/`maxPartBytes`/`maxEventsPerAppend`) settle the stream `aborted` and
  surface `BAD_REQUEST` — a runaway producer cannot grow a row forever.

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
passwordless user plus an API key — then let it connect with the same `chatClient` over the real wire. To hand
the agent the credentials it needs to act *for* a human (an external API key, a project id), vend them over
[`env`](/how-to/connection-env) — a typed, server-pushed per-connection bag its runtime reads (never the LLM):

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
- **Streaming bridge**: `pipeUIMessageStream(writer, result.toUIMessageStream())` maps an AI SDK v6
  chunk stream (from `streamText` or `agent.stream`) onto a streamed message — reasoning, tool
  calls, and text land live as parts. It never settles the message (`finalize`/`abort` stay yours);
  a turn-level error chunk is *returned*, not thrown. The collections-chat example's bot answers
  this way — its tool calls visibly stream into #ask-ai.

## Mastra agents — `@super-line/plugin-chat/mastra`

Hook plain [Mastra](https://mastra.ai) `Agent`s to streamed messages exactly the way
super-harness hooks them to its cockpit — hand them over and the engine owns the wiring
(`@mastra/core` is an optional peer dependency, like `ai`):

```ts
import { Agent } from '@mastra/core/agent'
import { mastraEngine } from '@super-line/plugin-chat/mastra'

const worker = new Agent({ id: 'worker', instructions: '…', model, tools: { weather } })
const supervisor = new Agent({ id: 'supervisor', instructions: '…', model }) // no delegate tool here!

const engine = mastraEngine({ agent: supervisor, subagents: [{ agent: worker }] })
await engine.respond(chat, channelId, history) // one whole turn → one settled streamed message
```

What the engine owns, so your agents stay vanilla:

- **The `delegate` tool** — injected per stream call via Mastra `toolsets` (`{ agentType, task } →
  { content, isError }`), never baked into your `Agent`. Config declares the topology:
  `delegatesTo` edges (default: the root may delegate to every subagent, subagents are leaves) and
  `maxDepth` (default 3). Illegal edges, unknown agents, and depth overruns come back to the model
  as `isError` tool results.
- **Lanes and nesting** — the supervisor streams at the root; each delegation streams *into the
  same message*, its parts nested under the delegate call's tool part (`parent`). The delegate
  part is always emitted: it IS the anchor. Renderers wanting a distinct card special-case
  `toolName === 'delegate'`.
- **The chunk mapping** — the harness's Mastra `fullStream` mapper, vocabulary preserved
  (text/reasoning segmentation at tool boundaries, whole args, `tool-error` → error result).
- **Failure semantics** — a subagent's failure becomes the delegate's `isError` result and the
  turn continues (the model sees it and may retry); a ROOT-level error chunk is returned;
  `respond` then settles `{ status: 'error' }`, deletes turns that never streamed anything, and
  aborts on a thrown failure.
- **Abort, one mechanism** — `opts.abortSignal` and a dead sink (flush checked once per LLM step:
  kill-switch, cap violation, disconnect) both cancel every in-flight lane at every depth.

`engine.run(sink, input)` is the composable half (any `StreamEventSink`, never settles);
`pipeMastraStream(sink, fullStream)` is the single-lane escape hatch, the exact Mastra sibling of
`pipeUIMessageStream`.

## The bot loop — `onChatMessage` + `provisionChatBot`

The remaining boilerplate of "run a bot" is two calls. Server-side, mint the identity
(idempotent across restarts — finds by display name, reactivates if soft-deleted, revokes and
re-mints the same-label API key, joins channels):

```ts
import { provisionChatBot } from '@super-line/plugin-chat/server'
const { user, apiKey } = await provisionChatBot(authKit, chatKit, { name: 'Supervisor' })
```

Client-side (same process or not — the bot is a regular user over the wire), run the loop:

```ts
import { chatClient, onChatMessage } from '@super-line/plugin-chat/client'

const bot = chatClient(client, { userId: user.id })
await bot.ready
onChatMessage(bot, async ({ channelId, message, history }) => {
  await engine.respond(bot, channelId, history) // or any AI-SDK producer — the loop doesn't care
}, { channels: 'all', historyLimit: 8 })
```

The loop owns what every hand-rolled bot got subtly wrong: backlog is context, not triggers; own
messages are skipped; another producer's still-streaming message defers until it settles;
`history` arrives model-ready (`{ role, content }`, settled turns only, textless turns kept with
honest `[error: … — no text]` placeholders); a failed join retries on the next directory tick.
`channels: 'all'` means every channel the bot can *see* (RLS: public + already-member private),
auto-joining public ones on appear — a new channel is a new conversation; pass an id list to pin
it down. And turns are **serialized per channel**: a message arriving mid-answer queues, and its
turn's history already contains the finished answer. Channels stay concurrent with each other.
