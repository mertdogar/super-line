# Tutorial 6 · A human and an agent co-edit a canvas

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <a href="/tutorials/ai-agent-chat">5 · Put a live AI agent in the chat</a> → <strong>6 · Co-edit a canvas</strong></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
In <a href="/tutorials/ai-agent-chat">Tutorial 5</a> the agent answered in <em>text</em>. Now it edits a <strong>document</strong> — a shared sticky-note canvas that a human and the agent change at the same time. The canvas is a <a href="/collections/crdt-documents">CRDT document</a> the chat plugin attaches to the channel as a <strong>channel resource</strong>: the human edits it through the native handle, the agent through an acked <code>write_resource</code> path, and both edits <strong>merge</strong>. This is the shape behind the <a href="https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor"><code>chat-supervisor</code></a> demo.
</p>

<p class="sl-qs-meta">
  <span>~15 minutes</span>
  <span>Builds on Tutorials 3 + 5</span>
  <span>TypeScript · zero codegen</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Register</b> a resource kind</span>
  <span class="sl-qs-pill"><b>Open</b> the doc (<code>DocHandle</code>)</span>
  <span class="sl-qs-pill"><b>Agent writes</b> via <code>write_resource</code></span>
</p>

</div>

This lesson continues the `my-line` project from [Tutorial 5](/tutorials/ai-agent-chat) — same folder, same ESM + `tsx` setup. Keep [Attach collaborative resources to channels](/how-to/chat-resources) and [CRDT document collections](/collections/crdt-documents) open for the model behind the API. As before it runs as **one file** you can read top to bottom.

## 1. Two hands on one document

A **channel resource** is one [CRDT document](/collections/crdt-documents) plus a registry row linking it to a channel. Two writers touch it, through two different doors:

| Writer | Door | Why |
| --- | --- | --- |
| the **human** | `client.collection(n).open(id)` → a `DocHandle` | optimistic, live; a rejected write silently resyncs |
| the **agent** | `chat.writeResource(...)` (the [`write_resource`](/how-to/chat-resources#_4-·-agent-writes-the-acked-path) tool) | **acked** — the write is applied server-side and returns the new snapshot, or a `VALIDATION` error the model can read and correct |

Both go through the **same membership gate**: the agent is a real channel member (a [provisioned bot](/how-to/chat-bots)), so its writes are authorized exactly like a human's. That's the whole idea — the agent isn't a privileged co-writer bolted onto the server; it's a participant with the same access as everyone else in the channel.

## 2. Declare the canvas, register the kind

The canvas is **your** CRDT document collection — the plugin never owns the schema. Add it to `src/contract.ts` alongside the two plugins from Tutorial 4. The `notes` map is `.catch({})` so concurrent edits never trip [validate-before-commit](/collections/crdt-documents#validate-before-commit); `title` stays strict (it's set once).

```ts [src/contract.ts]
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

export const canvasSchema = z.object({
  title: z.string(),
  notes: z.record(z.string(), z.object({ x: z.number(), y: z.number(), color: z.string(), text: z.string() })).catch({}),
})
export type Canvas = z.infer<typeof canvasSchema>

export const chat = defineContract({
  collections: { canvases: { schema: canvasSchema, crdt: { mode: 'document' } } },
  roles: { user: {}, guest: {} },
  plugins: [authContract(), chatContract()],
})
```

Registering the kind on the chat kit is what makes it channel-native — one act, three effects (`createResource` enabled, membership-gated policies contributed, delete-cascade enrolled). You'll wire this into `chatKit` in the next step.

::: tip `owned` vs `linked`
This canvas is **`owned`** (the default): chat mints its id and deletes it when the channel goes. Use **`linked`** instead when the document is content that outlives the channel and may attach to several — a design scene, a shared doc. See [the lifecycle table](/how-to/chat-resources#_2-·-register-the-kinds-one-act-three-effects).
:::

## 3. Stand up the server and provision the bot

Same `authKit` + `chatKit` as Tutorial 5, plus two additions: a **`crdtCollections` backend** for the documents, and the **`resources.kinds`** registration. Start a fresh file `src/collaborative-canvas.ts`:

```ts [src/collaborative-canvas.ts]
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtMemoryCollections, crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { auth } from '@super-line/plugin-auth/server'
import { chat as chatKitFactory, provisionChatBot } from '@super-line/plugin-chat/server'
import { chatClient, onChatMessage } from '@super-line/plugin-chat/client'
import { chat, type Canvas } from './contract'

const server = http.createServer()
const backend = memoryCollections()
const crdt = crdtMemoryCollections()

const authKit = auth({ contract: chat, collections: backend, defaultRoles: ['user'] })
// Registering the `canvas` kind wires create + membership policies + the delete cascade.
const chatKit = chatKitFactory({
  contract: chat,
  resources: { kinds: { canvas: { collection: 'canvases', init: () => ({ title: 'Canvas', notes: {} }) } } },
})

createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server })],
  collections: backend,
  crdtCollections: crdt,                      // the documents live here
  plugins: [authKit.plugin, chatKit.plugin],
  authenticate: authKit.authenticate,
  identify: authKit.identify,
})

server.listen(3000, () => console.log('super-line canvas server on ws://localhost:3000'))

const room = await chatKit.channels.create({ name: 'design', visibility: 'public' })
```

Now provision the bot and run its loop. Offline and deterministic first: when a message asks for a note, the bot **writes it straight to the canvas** with `writeResource`, then confirms in one line. (You'll swap in a real LLM in step 6 — the write path is identical.)

```ts [src/collaborative-canvas.ts]
const { user: bot, apiKey } = await provisionChatBot(authKit, chatKit, { name: 'Editor', channels: [room.id] })
const botClient = createSuperLineClient(chat, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
  role: 'user',
  params: { apiKey },
  crdtCollections: crdtCollectionsClient(),   // required to touch documents
})
const botChat = chatClient(botClient, { userId: bot.id })
await botChat.ready

let n = 0
onChatMessage(botChat, async ({ channelId, message }) => {
  const text = typeof message.content === 'string' ? message.content : ''
  const m = text.match(/note (?:that says |saying )?["“]?([^"”]+)["”]?/i)
  if (!m) return
  // Find the channel's canvas resource, then write ONE note onto it — acked, returns the new snapshot.
  const resources = botChat.resources(channelId)
  await resources.ready
  const canvas = resources.rows().find((r) => r.kind === 'canvas')
  if (!canvas) return
  const { snapshot } = await botChat.writeResource(channelId, 'canvas', canvas.docId, [
    { path: ['notes', `bot-${++n}`], set: { x: 60 + n * 200, y: 80, color: '#bfdbfe', text: m[1].trim() } },
  ])
  await botChat.send(channelId, `Added a note: “${m[1].trim()}” (${Object.keys((snapshot as Canvas).notes).length} on the board).`)
}, { channels: [room.id] })
```

::: tip Why `writeResource` and not the raw co-writer
super-line also has a *server-side* co-writer (`srv.collection(n).open(id)`) — trusted, unvalidated, off the membership model. `writeResource` is the other choice: the agent acts as an ordinary **member**, its writes are membership-checked and best-effort validated, and it gets an honest `VALIDATION` error instead of a silent resync. For an agent that should live *inside* the channel like any user, reach for `writeResource`. See the [two-doors comparison](/how-to/chat-resources#_4-·-agent-writes-the-acked-path).
:::

## 4. The human creates the canvas and edits it live

Provision Ada, join `#design`, and **create the resource** — that mints the CRDT document and links it to the channel (dropping a resource card into the feed). Then open it as a `DocHandle` and add a note, exactly as a browser's [`useDoc`](/how-to/react) would.

```ts [src/collaborative-canvas.ts]
const ada = await authKit.users.create({ email: 'ada@my.line', displayName: 'Ada' })
const adaKey = (await authKit.apiKeys.create(ada.id, { role: 'user', label: 'canvas' })).key
const adaClient = createSuperLineClient(chat, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
  role: 'user',
  params: { apiKey: adaKey },
  crdtCollections: crdtCollectionsClient(),
})
const ada2 = chatClient(adaClient, { userId: ada.id })
await ada2.ready
await ada2.join(room.id)

// Create-or-attach the canvas, then open the document by id (literal name → typed handle).
const canvas = await ada2.createResource(room.id, { kind: 'canvas', title: 'Launch board' })
const doc = adaClient.collection('canvases').open(canvas.docId)
await doc.ready
doc.update({ notes: { 'ada-1': { x: 60, y: 300, color: '#fef08a', text: 'kickoff Friday' } } })
```

## 5. Both hands land — watch them merge

Ada asks the agent to add a note. The bot's loop wakes, writes to the **same document**, and Ada's open `DocHandle` — subscribed to the doc — sees the bot's note appear next to hers.

```ts [src/collaborative-canvas.ts]
doc.subscribe(() => {
  const notes = Object.values(doc.getSnapshot()?.notes ?? {})
  console.log(`🖼  board (${notes.length}): ${notes.map((x) => `“${x.text}”`).join(', ')}`)
})

await ada2.send(room.id, 'add a note that says ship it')

await new Promise((r) => setTimeout(r, 2000))   // let the bot write + fan out
doc.close()
ada2.close()
botChat.close()
process.exit(0)
```

Run it — one file, no keys:

```bash
npx tsx src/collaborative-canvas.ts
```

```ansi
super-line canvas server on ws://localhost:3000
🖼  board (1): “kickoff Friday”
🖼  board (2): “kickoff Friday”, “ship it”
```

<div class="sl-result">
  <p class="sl-result__h">A human and an agent just edited one document — and both edits survived.</p>
  <p>Ada opened the canvas with a <code>DocHandle</code> and dropped a note. Her <code>send</code> woke the bot's loop, which wrote a second note through <code>writeResource</code> — server-side, membership-checked, acked. Because it's a <a href="/collections/crdt-documents">CRDT document</a>, the two writes to different keys <strong>merged</strong> instead of clobbering, and Ada's live handle re-rendered with both. Swap Ada for a browser tab with <a href="/how-to/react"><code>useDoc</code></a> and you have the <code>chat-supervisor</code> app.</p>
</div>

## 6. Give it a real brain

The offline bot pattern-matched one command. Swap it for an LLM and it can decide *what* to draw — the write path doesn't change. `chatAgentTools` hands the model a `write_resource` tool (plus `list_resources`/`read_resource`) that rides the bot's own connection, so the server re-authorizes every call. Give it `resourceShapes` so it knows the canvas shape without reading first. Install the peers (`pnpm add ai @ai-sdk/gateway`) and replace the `onChatMessage` handler:

```ts [src/collaborative-canvas.ts]
import { ToolLoopAgent } from 'ai'
import { chatAgentTools, pipeUIMessageStream } from '@super-line/plugin-chat/ai'

const tools = chatAgentTools(botClient, {   // the bot's RAW client — tools ride its own connection
  resourceShapes: { canvas: '{ title: string, notes: Record<id, { x: number, y: number, color: string, text: string }> }' },
})
const agent = new ToolLoopAgent({
  model: 'anthropic/claude-haiku-4.5',          // via AI_GATEWAY_API_KEY
  instructions: `You edit the shared canvas in channel ${room.id}. Its resource is kind "canvas". ` +
    `Use write_resource to add/move/recolor notes (mint short unique ids; spread them out). Report what you did in one line.`,
  tools,
})

onChatMessage(botChat, async ({ channelId, history }) => {
  const w = await botChat.stream(channelId)
  try {
    const { error } = await pipeUIMessageStream(w, (await agent.stream({ messages: history })).toUIMessageStream())
    await w.finalize(error ? { status: 'error', error } : {})
  } finally {
    await w.abort().catch(() => {})
  }
}, { channels: [room.id] })
```

Now *"add a note for each launch task"* fans out to several `write_resource` calls, each landing on Ada's live board. The [`chat-supervisor`](https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor) example takes this one step further — the editor is a *subagent* the supervisor delegates to, so the canvas edits stream as their own card.

## What just happened

| What you wrote | Role | What it does |
| --- | --- | --- |
| `collections: { canvases: { schema, crdt } }` | **Contract** | Your own CRDT document collection — the plugin never owns the schema. |
| `resources: { kinds: { canvas: { collection, init } } }` | **Server** | Registers the kind: `createResource` + membership policies + delete cascade, in one line. |
| `createResource(channelId, { kind })` | **Client (human)** | Mints the document and links it to the channel; drops a resource card. |
| `collection(n).open(id)` → `DocHandle` | **Client (human)** | Optimistic live editing — the browser's `useDoc`. |
| `writeResource(channelId, kind, docId, ops)` | **Client (agent)** | The acked, membership-gated, validated write path built for agents. |

The mental model: **the document is yours, the channel link is the plugin's, and the agent edits it as a member — not as a privileged server.**

## Next

- [Attach collaborative resources to channels (how-to)](/how-to/chat-resources) — the full resource surface: `linked` lifecycle, presence, the delete cascade, and the caveats.
- [`examples/chat-supervisor`](https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor) — this pattern as a real web app, with the agent as a delegated subagent and a live sticky-note UI.
- [`examples/chat-resources`](https://github.com/mertdogar/super-line/tree/main/examples/chat-resources) — the headless mechanics: `owned` vs `linked`, the cascade, and a `VALIDATION` rejection you can watch.
