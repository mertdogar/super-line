# Run an AI chat bot

**An AI agent is a regular user.** It doesn't get a bot type, a side-channel, or a special auth path — it's
a passwordless [plugin-auth](/how-to/plugin-auth) user with an API key that connects over the *same wire* a
browser uses and drives the *same* `chatClient`. Every message it sends, every channel it reads, shows up
in the Control Center like any other participant, and the server authorization-checks all of it: the model
can never exceed its bot user's permissions.

This guide assembles a bot from four library calls:

1. **`provisionChatBot`** — mint (idempotently) the bot's identity + API key and join its channels.
2. **`onChatMessage`** — the channel loop: watch, detect new messages, assemble history, hand you a turn.
3. **`chatAgentTools`** — an AI SDK toolset over the bot's own permission-checked connection.
4. **`mastraEngine`** / **`pipeUIMessageStream`** — turn a model's output into a
   [streamed message](/how-to/chat-streaming).

For the human-side wiring behind all this, keep [the chat backbone how-to](/how-to/plugin-chat) open.

## 1 · Provision the bot — `provisionChatBot`

Mint the identity server-side. It's **idempotent across restarts**: it finds the user by display name,
reactivates a soft-deleted one, revokes and re-mints the same-label API key (so restarts don't accumulate
live keys), and joins the given channels.

```ts
import { provisionChatBot } from '@super-line/plugin-chat/server'

const { user, apiKey } = await provisionChatBot(authKit, chatKit, {
  name: 'Ask AI',            // the find-or-create identity key — keep it unique among your bots
  channels: [channelId],     // joined as a member (idempotent)
})
```

Only accounts this function created are ever adopted — it writes an unconditional `metadata.bot === true`
marker at creation and matches on it, so a human who signed up as "Ask AI" is never hijacked. Options:
`email` (first-creation only, default `<slug>@bots.local`), `role` (the API key's connect role, default
`'user'`), `keyLabel` (default `<slug>-bot`), and `metadata`.

::: tip Provisioning by hand
`provisionChatBot` is the convenience wrapper. The primitives are just plugin-auth + chatKit:
`authKit.users.create(...)` → `authKit.apiKeys.create(...)` → `chatKit.members.add(...)`. Reach for them
when you need a non-standard identity flow.
:::

## 2 · Connect it as a client

Same process or not — the bot is a regular user over the wire. Connect an ordinary super-line client with
the API key and wrap it in `chatClient`:

```ts
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { chatClient } from '@super-line/plugin-chat/client'

const client = createSuperLineClient(app, {
  transport: webSocketClientTransport({ url }),
  role: 'user',
  params: { apiKey },
})
const bot = chatClient(client, { userId: user.id })
await bot.ready
```

## 3 · Run the loop — `onChatMessage`

`onChatMessage` is the message loop every hand-rolled bot got subtly wrong. It watches channels, detects
new messages, assembles model-ready history, and calls your handler — then returns a detach function.

```ts
import { onChatMessage } from '@super-line/plugin-chat/client'

const detach = onChatMessage(bot, async ({ channelId, message, history }) => {
  await engine.respond(bot, channelId, history) // or any AI-SDK producer — the loop doesn't care
}, { channels: 'all', historyLimit: 8 })
```

What the loop owns so you don't reimplement it:

- **Backlog is context, not triggers** — messages already present when the bot joins seed history but never
  fire the handler.
- **Own messages are skipped**, and another producer's **still-streaming** message defers until it settles.
- **`history` arrives model-ready** — `{ role, content }`, settled turns only, oldest→newest, the trigger
  included. Textless turns are kept with an honest `[error: … — no text]` placeholder rather than dropped.
- **Turns are serialized per channel** — a message arriving mid-answer queues, and its turn's history
  already contains the finished answer. Channels stay concurrent with each other.
- **`channels: 'all'`** (default) means every channel the bot can *see* (RLS: public + already-member
  private), auto-joining public ones on appear — a new channel is a new conversation. A failed join retries
  on the next directory tick instead of silently blinding the bot; being kicked silences the bot there (it
  never force-rejoins). Pass an id list to pin it down. `historyLimit` defaults to 8.

The handler's `message` is the assembled trigger (with `parts`/`status` for a streamed turn); most bots
just read `history`.

## 4 · Give it a brain

The loop is framework-agnostic — pair it with anything that produces text. Three options, simplest first.

### A hand-written streamed reply

The floor: open a [stream](/how-to/chat-streaming), push text, settle. No model needed — this is the whole
"offline" path in the examples:

```ts
onChatMessage(bot, async ({ channelId, history }) => {
  const w = await bot.stream(channelId)
  try {
    w.push({ type: 'part_start', key: 't', partType: 'text' })
    w.push({ type: 'delta', key: 't', text: reply(history) })
    w.push({ type: 'part_end', key: 't' })
    await w.finalize()
  } finally {
    await w.abort().catch(() => {})
  }
})
```

### The AI SDK toolset — `chatAgentTools` {#toolset}

`chatAgentTools(client)` returns a plain [Vercel AI SDK](https://ai-sdk.dev) `ToolSet` over the agent's
**own connection** — so every tool call is authorization-checked by the server. RLS scopes
`list_channels`/`read_messages` to what the bot can see, `send_message` requires membership, and management
needs ownership: **the model can never exceed its bot user's permissions.** (`ai` is an optional peer
dependency, like `react`.)

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
- It's a plain record — spread-omit tools you don't want. A common pattern: drop `send_message` and let the
  runtime own the posting (so the reply **streams** as one message instead of arriving as a plain send),
  keeping the LLM's tools read-only.
- **Stateless** — each read is a one-shot subscribe→snapshot→close, each write is one typed request; no
  lifecycle to manage, nothing to close.

### Stream the answer — `pipeUIMessageStream`

`pipeUIMessageStream(writer, result.toUIMessageStream())` maps an AI SDK v6 chunk stream (from `streamText`
or `agent.stream`) onto a [streamed message](/how-to/chat-streaming) — reasoning, tool calls, and text land
live as parts. It never settles the message (`finalize`/`abort` stay yours); a turn-level error chunk is
**returned**, not thrown. Putting the toolset and the bridge together:

```ts
// drop send/join/leave: the runtime owns posting, so the reply streams as one message
const { send_message, join_channel, leave_channel, ...contextTools } = chatAgentTools(client)
const agent = new ToolLoopAgent({
  model: 'anthropic/claude-sonnet-5',
  instructions: `You are "Ask AI" in channel ${channelId}. Read the room; answer in one short paragraph.`,
  tools: { ...contextTools, weather: weatherTool },
})

onChatMessage(bot, async ({ channelId, history }) => {
  const w = await bot.stream(channelId)
  let pushed = false
  const sink = { push: (...e) => { pushed = true; w.push(...e) } }
  try {
    const result = await agent.stream({ messages: history })
    const { error } = await pipeUIMessageStream(sink, result.toUIMessageStream())
    if (!pushed) {                              // never leave an empty bubble behind
      await w.abort('empty reply')
      await bot.deleteMessage(w.messageId).catch(() => {})
      return
    }
    await w.finalize(error !== undefined ? { status: 'error', error } : {})
  } catch (err) {
    await w.abort(String(err)).catch(() => {})
    throw err
  }
}, { channels: [channelId] })
```

This is exactly the [`examples/collections-chat`](https://github.com/mertdogar/super-line/tree/main/examples/collections-chat)
bot — its tool calls visibly stream into `#ask-ai`.

## Mastra agents — `mastraEngine` {#mastra}

For a **supervisor + subagents** turn, hook plain [Mastra](https://mastra.ai) `Agent`s to streamed
messages exactly the way super-harness hooks them to its cockpit — hand them over and the engine owns the
wiring (`@mastra/core` is an optional peer dependency):

```ts
import { Agent } from '@mastra/core/agent'
import { mastraEngine } from '@super-line/plugin-chat/mastra'

const worker = new Agent({ id: 'worker', instructions: '…', model, tools: { weather } })
const supervisor = new Agent({ id: 'supervisor', instructions: '…', model }) // no delegate tool here!

const engine = mastraEngine({ agent: supervisor, subagents: [{ agent: worker }] })
onChatMessage(bot, ({ channelId, history }) => engine.respond(bot, channelId, history))
```

`engine.respond(chat, channelId, input)` is the one-call turn: open a streamed message, run the whole tree
into it, and settle — `complete` normally, `{ status: 'error' }` on a turn-level error, `abort` + rethrow
on a thrown failure. A turn that never streamed anything (and didn't error) is deleted rather than
finalized blank.

What the engine owns, so your agents stay vanilla:

- **The `delegate` tool** — injected per stream call via Mastra `toolsets` (`{ agentType, task } →
  { content, isError }`), never baked into your `Agent`. Config declares the topology: `delegatesTo` edges
  (default: the root may delegate to every subagent; subagents are leaves) and `maxDepth` (default 3).
  Illegal edges, unknown agents, and depth overruns come back to the model as `isError` tool results.
- **Lanes and nesting** — the supervisor streams at the root; each delegation streams *into the same
  message*, its parts nested under the delegate call's tool part ([supervisor trees](/how-to/chat-streaming#supervisor-trees)).
- **The chunk mapping** — the harness's Mastra `fullStream` mapper, vocabulary preserved (text/reasoning
  segmentation at tool boundaries, whole tool args, `tool-error` → error result).
- **Failure semantics** — a subagent's failure becomes the delegate's `isError` result and the turn
  continues (the model sees it and may retry); a root-level error chunk settles `{ status: 'error' }`.
- **Abort, one mechanism** — `opts.abortSignal` and a dead sink (checked once per LLM step: kill-switch,
  cap violation, disconnect) both cancel every in-flight lane at every depth.

And it owns nothing else: the engine's stream calls carry only the abort signal, the delegate
toolset, and your per-turn `requestContext`. Every per-agent knob — `maxSteps`, provider options,
memory — lives on **your** `Agent` via Mastra's `defaultOptions`, which deep-merges under the
engine's call options. The two sections below are that rule in action.

### Streaming reasoning {#thinking}

Thinking tokens stream as `reasoning` parts the moment the model emits them — enabling them is model
configuration on **your** Agent, not an engine option:

```ts
const thinking = {
  providerOptions: { anthropic: { thinking: { type: 'enabled' as const, budgetTokens: 2048 } } },
}
const worker = new Agent({ id: 'worker', /* … */ defaultOptions: thinking })
```

Mastra deep-merges `defaultOptions` under the engine's per-lane call options, so the setting follows
the agent into every lane — a thinking worker streams its reasoning *inside its delegation card*. The
AI-SDK path is symmetric: the same `providerOptions` on `ToolLoopAgent`/`streamText`
(`toUIMessageStream` forwards reasoning by default). One Anthropic caveat: with tools, thinking lands
at the **start** of a turn; thinking *between* tool calls is a separate interleaved-thinking beta.

### Per-channel memory {#memory}

Memory follows the same rule. Give the root agent a Mastra
[`Memory`](https://mastra.ai/docs/memory/overview) instance and derive the thread from the
`requestContext` you pass per turn — `defaultOptions` may be a function of it:

```ts
import { RequestContext } from '@mastra/core/request-context'

const supervisor = new Agent({
  id: 'supervisor',
  /* … */
  memory, // a Mastra Memory instance
  defaultOptions: ({ requestContext }) => ({
    memory: { thread: String(requestContext?.get('channelId')), resource: 'supervisor-bot' },
  }),
})

onChatMessage(bot, ({ channelId, history }) => {
  const rc = new RequestContext()
  rc.set('channelId', channelId)
  return engine.respond(bot, channelId, history.slice(-1), { requestContext: rc })
})
```

Two things fall out of doing it this way:

- **Workers stay stateless by construction.** The engine forwards `requestContext` to every lane,
  but only agents whose `defaultOptions` derive `memory` from it get a thread — delegation briefs
  stay self-contained, and worker turns never pollute the channel's thread.
- **Hand the engine only the new turn** (`history.slice(-1)`), not the assembled history: with
  memory on, Mastra saves the stream input to the thread and recalls prior turns itself — passing
  full `history` would both snowball the thread and double the model's context.

`engine.run(sink, input)` is the composable half (any `StreamEventSink`, never settles);
`pipeMastraStream(sink, fullStream)` is the single-lane escape hatch, the Mastra sibling of
`pipeUIMessageStream`. The
[`examples/chat-supervisor`](https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor)
app is the whole thing end to end.

## Vend the bot its credentials — `env`

A bot that must act *for* a human (call an external API, use a project id) needs credentials — but those
are **not** super-line's identity. Hand them to the connection over [`env`](/how-to/connection-env): a
typed, server-pushed per-connection bag the bot's *runtime* reads (never the LLM). super-line is a pure
courier — it validates and delivers `env`, never interprets it — so there's no impersonation and no
on-behalf-of in the protocol.

```ts
// server: seed it at connect (authenticate → env) or push it live
srv.toUser(botUserId).setEnv({ projectId, ommaApiKey })

// bot runtime: read it off the raw client (NOT the chatClient), wire it into a tool — never a prompt
await client.env.ready
const { ommaApiKey } = client.env.current ?? {}
```

See [Hand a connection its credentials (env)](/how-to/connection-env) for the full flow.

## Recap

| Call | Package | Role |
| --- | --- | --- |
| `provisionChatBot` | `/server` | Idempotent bot identity + API key + channel join. |
| `onChatMessage` | `/client` | The per-channel message loop → model-ready turns. |
| `chatAgentTools` | `/ai` | Permission-checked AI SDK toolset over the bot's connection. |
| `pipeUIMessageStream` | `/ai` | AI SDK chunk stream → a streamed chat message. |
| `mastraEngine` / `pipeMastraStream` | `/mastra` | Supervisor+subagent (or single Mastra) turn → a streamed message. |

Ready to build one from scratch? [Tutorial 5 · Put a live AI agent in the chat](/tutorials/ai-agent-chat)
walks the whole thing in one runnable file.
