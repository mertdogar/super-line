# Tutorial 5 · Put a live AI agent in the chat

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <a href="/tutorials/chat-backbone">4 · Assemble a chat backbone</a> → <strong>5 · Put a live AI agent in the chat</strong></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
In <a href="/tutorials/chat-backbone">Tutorial 4</a> two humans talked over a channel. Now a third participant joins — an <strong>AI agent</strong>. The trick that makes this simple: super-line has no bot type. The agent is a <em>regular user</em> with an API key on the same wire, and three library calls turn it into a live participant whose whole answer <strong>streams</strong> into the channel as one message. No model key required — you'll run it fully offline first, then swap in a real LLM in one block.
</p>

<p class="sl-qs-meta">
  <span>~10 minutes</span>
  <span>Builds on Tutorial 4</span>
  <span>TypeScript · zero codegen</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Provision</b> a bot user</span>
  <span class="sl-qs-pill"><b>Loop</b> <code>onChatMessage</code></span>
  <span class="sl-qs-pill"><b>Stream</b> a reply</span>
</p>

</div>

This lesson continues the `my-line` project from [Tutorial 4](/tutorials/chat-backbone) — same folder, same `src/contract.ts`, same ESM + `tsx` setup. As before we'll run the whole thing as **one file** you can read top to bottom: a server, a provisioned bot that streams replies, and a human whose message triggers it. For the model behind it, keep [Run an AI chat bot](/how-to/chat-bots) and [Stream an agent's turn](/how-to/chat-streaming) open.

## 1. The agent is just a user

There's no special path here. An AI agent is a **passwordless [plugin-auth](/how-to/plugin-auth) user with an API key** that connects over the same WebSocket a browser uses and drives the same `chatClient`. The server authorization-checks every one of its actions, so the model can never exceed its bot user's permissions — and its traffic shows up in the Control Center like anyone else's.

Three calls assemble it:

| Call | From | Does |
| --- | --- | --- |
| `provisionChatBot` | `/server` | Mints (idempotently) the bot's user + API key and joins its channel. |
| `onChatMessage` | `/client` | The channel loop — watches, skips own/backlog messages, hands you each new turn with history. |
| `bot.stream(...)` | `/client` | Opens a [streamed message](/how-to/chat-streaming) the reply lands in live. |

## 2. Stand up the server

Same shape as Tutorial 4 — `authKit` + `chatKit`, one backend, both plugins — plus a public `#ask-ai` channel for the agent to live in. Start a fresh file `src/ai-agent-chat.ts`:

```ts [src/ai-agent-chat.ts]
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { memoryCollections } from '@super-line/collections-memory'
import { auth } from '@super-line/plugin-auth/server'
import { chat as chatKitFactory, provisionChatBot } from '@super-line/plugin-chat/server'
import { chatClient, onChatMessage } from '@super-line/plugin-chat/client'
import { chat } from './contract'

const server = http.createServer()
const backend = memoryCollections()

const authKit = auth({ contract: chat, collections: backend, defaultRoles: ['user'] })
const chatKit = chatKitFactory({ contract: chat })

createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server })],
  collections: backend,
  plugins: [authKit.plugin, chatKit.plugin],
  authenticate: authKit.authenticate,
  identify: authKit.identify,
})

server.listen(3000, () => console.log('super-line chat server on ws://localhost:3000'))

// A public channel the agent lives in (imperative chatKit — server-authoritative).
const room = await chatKit.channels.create({ name: 'ask-ai', visibility: 'public' })
```

## 3. Provision the bot and run its loop

`provisionChatBot` mints the identity and joins it to `#ask-ai`. Then the bot connects like any client, and `onChatMessage` drives the loop — for each new human message it opens a stream and types a reply word-by-word. **No model key needed**: this responder is deterministic, but it's a *real* stream over the wire, so you see live delivery exactly as a production agent produces it.

Append below the `channels.create` call:

```ts [src/ai-agent-chat.ts]
// Mint the bot user + API key, join it to #ask-ai (idempotent across restarts).
const { user, apiKey } = await provisionChatBot(authKit, chatKit, {
  name: 'Ask AI',
  channels: [room.id],
})

// The bot connects as a REGULAR user over the same WebSocket, then wraps in a chatClient.
const botClient = createSuperLineClient(chat, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
  role: 'user',
  params: { apiKey },
})
const bot = chatClient(botClient, { userId: user.id })
await bot.ready

// The loop: for every new message (own + backlog excluded, turns serialized per channel),
// stream a reply. `history` is model-ready — settled turns, oldest→newest, this one included.
onChatMessage(
  bot,
  async ({ channelId, message }) => {
    const asked = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    const reply = `You said “${asked}”. I'm the offline demo bot — add a model to give me a brain.`

    const w = await bot.stream(channelId)               // opens a streaming message; the bot is its author
    try {
      w.push({ type: 'part_start', key: 't', partType: 'text' })
      for (const word of reply.split(/(?<=\s)/)) {       // typewriter: one delta per word
        w.push({ type: 'delta', key: 't', text: word })
        await new Promise((r) => setTimeout(r, 40))
      }
      w.push({ type: 'part_end', key: 't' })
      await w.finalize()                                 // settle → status 'complete', content projected
    } finally {
      await w.abort().catch(() => {})                    // no-op if already settled; never leave a stream open
    }
  },
  { channels: [room.id] },
)
```

::: tip Why settle in a `finally`
A stream that's never settled leaks — the message sits `streaming` forever. `finalize` settles it normally; `abort` in the `finally` is a safety net that's a no-op once `finalize` ran. This is the one rule every streamed reply follows. See [the streaming guide](/how-to/chat-streaming#producing-a-stream).
:::

## 4. A human asks — and watches the reply stream

Now provision a human, join `#ask-ai` (it's public — self-service), open a live feed, and send a question. The bot's answer arrives as an **assembled** streamed message: `msg.parts` carries its text with live deltas already spliced, and `msg.status` walks `streaming → complete`.

Append this below:

```ts [src/ai-agent-chat.ts]
// Provision Ada as a real user + API key and connect her.
const ada = await authKit.users.create({ email: 'ada@my.line', displayName: 'Ada' })
const adaKey = (await authKit.apiKeys.create(ada.id, { role: 'user', label: 'tracer' })).key
const adaChat = chatClient(
  createSuperLineClient(chat, {
    transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
    role: 'user',
    params: { apiKey: adaKey },
  }),
  { userId: ada.id },
)
await adaChat.ready
await adaChat.join(room.id)

// Render an assembled message to text: a streamed one joins its text parts; a plain one is its content.
const render = (m: { parts?: { type: string; text: string }[]; content?: unknown; status?: string }): string =>
  m.parts
    ? m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('') + (m.status === 'streaming' ? ' ▍' : '')
    : String(m.content ?? '')

// Watch the channel. The bot's reply re-renders on every delta — you see it type.
const feed = adaChat.messages(room.id)
await feed.ready
feed.subscribe(() => {
  const last = feed.rows().at(-1)
  if (last && last.authorId === user.id) console.log(`🤖 ${render(last)}`)
})

// Ada asks. The message travels to the server, the bot's loop wakes, and it streams back.
await adaChat.send(room.id, 'hello there')

await new Promise((r) => setTimeout(r, 3000)) // let the stream finish, then exit
adaChat.close()
bot.close()
botClient.close()
process.exit(0)
```

## 5. Run it

One file, one command — no keys, no setup:

```bash
npx tsx src/ai-agent-chat.ts
```

```ansi
super-line chat server on ws://localhost:3000
🤖 You ▍
🤖 You said ▍
🤖 You said “hello ▍
🤖 You said “hello there”. I'm the offline demo bot — add a model to give me a brain.
```

<div class="sl-result">
  <p class="sl-result__h">An AI participant just answered — live, over one contract.</p>
  <p>Ada's <code>send</code> reached the server, which woke the bot's <code>onChatMessage</code> loop. The bot opened a <strong>streamed message</strong> and pushed it word-by-word; Ada's feed re-rendered on every delta (the <code>▍</code> caret shows <code>status: 'streaming'</code>), then settled to the final text on <code>finalize</code>. The bot is a plain API-key user — nothing about it is special except that its brain runs in your loop.</p>
</div>

## 6. Give it a real brain

Swap the deterministic responder for a live LLM in one block. The [Vercel AI SDK](https://ai-sdk.dev) `chatAgentTools(client)` gives the model **permission-checked** hands in the workspace (it can only see and touch what its bot user can), and `pipeUIMessageStream` maps the model's output straight onto the writer — reasoning and tool calls stream as parts too. Install the peer deps (`pnpm add ai @ai-sdk/gateway`) and replace the `onChatMessage` handler body:

```ts [src/ai-agent-chat.ts]
import { ToolLoopAgent } from 'ai'
import { chatAgentTools, pipeUIMessageStream } from '@super-line/plugin-chat/ai'

// Drop send/join/leave so the runtime owns posting → the reply STREAMS as one message.
const { send_message, join_channel, leave_channel, ...tools } = chatAgentTools(botClient)
const agent = new ToolLoopAgent({
  model: 'anthropic/claude-sonnet-5',                         // via AI_GATEWAY_API_KEY
  instructions: `You are "Ask AI" in channel ${room.id}. Read the room; answer in one short paragraph.`,
  tools,
})

onChatMessage(bot, async ({ channelId, history }) => {
  const w = await bot.stream(channelId)
  let pushed = false
  const sink = { push: (...e: Parameters<typeof w.push>) => { pushed = true; w.push(...e) } }
  try {
    const result = await agent.stream({ messages: history })  // history is already model-ready
    const { error } = await pipeUIMessageStream(sink, result.toUIMessageStream())
    if (!pushed) {                                            // never leave an empty bubble
      await w.abort('empty reply')
      await bot.deleteMessage(w.messageId).catch(() => {})
      return
    }
    await w.finalize(error !== undefined ? { status: 'error', error } : {})
  } catch (err) {
    await w.abort(String(err)).catch(() => {})
    throw err
  }
}, { channels: [room.id] })
```

Everything else — the loop, the streaming, the human side — is unchanged. That's the point: the wire path was live all along; only the bot's brain moved from a string to a model.

## What just happened

| What you wrote | Role | What it does |
| --- | --- | --- |
| `provisionChatBot(authKit, chatKit, …)` | **Server** | Mints the bot's user + API key and joins its channel — idempotent across restarts. |
| `chatClient(botClient, { userId })` | **Client** | The bot drives the *same* client a human does, over the real wire. |
| `onChatMessage(bot, handler, …)` | **Client** | The channel loop: skips backlog + own messages, serializes turns, hands you model-ready history. |
| `bot.stream(...)` → `push` / `finalize` | **Client** | The reply is a streamed message — parts checkpoint durably, deltas render live. |

The mental model to keep: **the agent is a user, the loop is a library, the reply is a stream.** No agent-specific protocol, no impersonation — just a permission-checked participant on the bus.

## Next

- [Run an AI chat bot (how-to)](/how-to/chat-bots) — the full bot surface: the toolset, `mastraEngine` for supervisor+subagent turns, and vending the bot credentials over [`env`](/how-to/connection-env).
- [Stream an agent's turn (how-to)](/how-to/chat-streaming) — the streamed-message model in depth: parts, supervisor trees, checkpoints, and the streaming knobs.
- [`examples/collections-chat`](https://github.com/mertdogar/super-line/tree/main/examples/collections-chat) — this pattern in a real Slack-like UI, with a live AI agent in `#ask-ai`.
- [`examples/chat-supervisor`](https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor) — a Mastra supervisor delegating to a worker, the whole tree streaming into one message.
