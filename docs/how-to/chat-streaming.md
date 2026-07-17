# Stream an agent's turn

A chat message can be **streamed**: opened empty, appended to live, settled at the end — and it stores the
*entire* turn as typed **parts** (`text` · `reasoning` · `tool` calls with args/result/state), including
**subagent trees**. Viewers see token-smooth text on top of a durable floor, so late joiners, reloads, and
crashes always reconstruct the turn so far. This is how an AI agent's whole answer — reasoning, tool calls,
and the final text — lands as **one message** in a channel.

The decision record is
[ADR-0011](https://github.com/mertdogar/super-line/blob/main/docs/adr/0011-streamed-messages-are-parts-rows-plus-ephemeral-deltas.md).
This guide assumes you've wired the plugin in — see [the chat backbone how-to](/how-to/plugin-chat) first.

## The model in one picture

A streamed message is a normal `messages` row with `status: 'streaming'` and **no `content` yet**, plus a
set of `messageParts` rows — one row per block of the turn:

- **The durable floor.** Each in-flight part's row **checkpoints** its accumulated text roughly once a
  second, so anyone opening the channel reconstructs the turn from the database — never more than one
  checkpoint interval behind.
- **The smooth preview.** Between checkpoints, token deltas broadcast to a per-channel room as **ephemeral**
  events (`chat.streamDelta`), spliced onto the last checkpointed text by offset. A lost delta degrades
  smoothness, never correctness — the next checkpoint heals it.
- **The settle.** `finalize` flips `status` to `complete` (or `aborted` / `error`), marks every part done,
  and derives the plain `content` projection from the final parts.

You rarely touch parts directly on the read side: the assembled feed does the splicing for you. You *do*
drive the write side through a small writer.

## Producing a stream

Open a stream, push events, settle in a `finally`. The **same writer shape** works from a client and from
server code.

### From a client (`chat.stream`)

```ts
const w = await chat.stream(channelId) // opens the streaming message; you are its author
try {
  w.push({ type: 'part_start', key: 't', partType: 'text' })
  w.push({ type: 'delta', key: 't', text: 'Hello ' }, { type: 'delta', key: 't', text: 'world' })
  w.push({ type: 'part_end', key: 't' })
  await w.finalize() // derives the plain `content` projection; the finalizeMessage hook fires
} finally {
  await w.abort().catch(() => {}) // no-op if already settled; never leave a stream open
}
```

`push` queues events synchronously and the client micro-batches them onto the wire (~80 ms flushes, strict
order). A wire failure — a cap violation, a hook veto, a disconnect — surfaces at the **next**
`flush`/`finalize`, which is why you always settle in a `finally` (`abort` tolerates a server that already
settled the stream).

### From server code (`chatKit.messages.stream`)

Identical shape, no wire (events apply in order synchronously). Because a kit-initiated stream has no
connection whose disconnect could clean it up, settling in a `finally` is **mandatory**:

```ts
const w = await chatKit.messages.stream({ channelId, authorId: botId })
try {
  await w.push({ type: 'part_start', key: 't', partType: 'text' })
  await w.push({ type: 'delta', key: 't', text: 'done.' })
  await w.push({ type: 'part_end', key: 't' })
  await w.finalize()
} finally {
  await w.abort().catch(() => {})
}
```

### The event vocabulary

`push` takes a plugin-owned union (deliberately **not** the AI SDK's chunk type — [adapters](#bridges)
absorb SDK drift at the edge). `key` is your handle for a part; for **tool** parts it must be the
`toolCallId`.

| Event | Applies to | Meaning |
| --- | --- | --- |
| `{ type: 'part_start', key, partType, toolName?, parent? }` | any | Open a `text` / `reasoning` / `tool` part. `parent` nests it (see [trees](#supervisor-trees)). |
| `{ type: 'delta', key, text }` | text · reasoning | Append text. Tool args do **not** stream — they land whole. |
| `{ type: 'part_patch', key, args?, result?, isError?, state? }` | tool | Set a tool call's args, result, error flag, or lifecycle `state`. |
| `{ type: 'part_end', key, text? }` | any | Close the part. An optional `text` authoritatively replaces the accumulated text (heals a lost delta). |

Tool state is **monotonic** (`input-streaming → running → done`), so a stale patch can never regress a part
behind a landed result.

## Consuming a stream

Consumers do **nothing special**. The same `chat.messages(channelId)` feed serves streamed messages
**assembled**: the store subscribes the message window *and* the channel's parts, watches the delta room,
and splices live text by offset — one feed, no second API.

```ts
const feed = chat.messages(channelId)
feed.subscribe(() => {
  for (const msg of feed.rows()) {
    if (msg.parts) renderAgentTurn(msg) // msg.parts is tree-ordered, live text already spliced
    else renderBubble(msg)              // a plain send — parts absent
  }
})
```

Each assembled message carries:

- **`msg.parts`** — the parts in tree order (a delegate tool part immediately followed by its subagent's
  parts), with in-flight text already overlaid. Absent on a plain send, and absent on a settled streamed
  message whose parts scrolled out of the recency window (render `msg.content` then).
- **`msg.status`** — `streaming → complete | aborted | error`. Plain sends have no `status`.

Render with one branch: `msg.parts ? <AgentTurn/> : <Bubble/>`. In React the `useMessages(channelId)` hook
returns exactly these assembled rows.

The parts window is **recency-bounded** (`partsLimit`, default 1000, most-recently-active first) so opening
an old channel doesn't pull every part ever streamed into memory. Pass `{ streaming: false }` to
`chat.messages` to opt out entirely — plain rows only, no parts subscription, no room watch.

## Supervisor trees {#supervisor-trees}

A part may **nest** under a delegate tool call via `parent` (the delegating part's `toolCallId`), so one
message can carry a whole multi-agent turn — each delegation rendering as its own card with the subagent's
tool calls and text inside, durable across reloads.

```ts
// the supervisor's lane streams a delegate tool call, key = its toolCallId
w.push({ type: 'part_start', key: 'call_42', partType: 'tool', toolName: 'delegate' })
// the worker's lane nests UNDER it — parent names the delegate part
w.push({ type: 'part_start', key: 'w1', partType: 'text', parent: 'call_42' })
w.push({ type: 'delta', key: 'w1', text: 'Ankara is 14°C.' })
w.push({ type: 'part_end', key: 'w1' })
w.push({ type: 'part_patch', key: 'call_42', result: { ok: true } })
w.push({ type: 'part_end', key: 'call_42' })
```

The delegate part is always the **anchor** its children hang off — renderers wanting a distinct card
special-case `toolName === 'delegate'`. You almost never build these trees by hand for Mastra agents:
[`mastraEngine`](/how-to/chat-bots#mastra) owns the lanes, the delegate tool, and the nesting, and the
[`examples/chat-supervisor`](https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor)
app rebuilds super-harness's supervisor/worker flow with it in a handful of lines.

## Bridges — from an AI SDK or Mastra stream {#bridges}

You'll rarely push raw events. Two one-line bridges map a model's chunk stream onto a writer; both **never
settle** the message (you own `finalize`/`abort`) and **return** a turn-level error rather than throwing it:

```ts
import { pipeUIMessageStream } from '@super-line/plugin-chat/ai'      // Vercel AI SDK v6
import { pipeMastraStream } from '@super-line/plugin-chat/mastra'      // one Mastra fullStream

const { error } = await pipeUIMessageStream(w, result.toUIMessageStream())
await w.finalize(error !== undefined ? { status: 'error', error } : {})
```

These live in the [AI-bot guide](/how-to/chat-bots) alongside `mastraEngine`, which drives the whole
supervisor tree for you.

## Structured content hosts {#structured-content}

The settled `content` is **projected** from the final parts. The default projection joins the root-lane
text parts with blank lines — valid for the default `z.string()` body. If you gave `chatContract({ content })`
a **structured** schema, you must supply a matching projection or the settle fails loudly:

```ts
const chatKit = chat({
  contract: app,
  streaming: {
    project: (parts) => ({
      type: 'text',
      text: parts.filter((p) => p.type === 'text' && p.parent === null).map((p) => p.text).join('\n\n'),
    }),
    // return undefined to leave `content` absent
  },
})
```

## Streaming knobs

Pass `chat({ streaming: { … } })`. Few by design — the defaults are the contract:

| Option | Default | What it bounds |
| --- | --- | --- |
| `checkpointMs` | `1000` | How often an in-flight part's row checkpoints (the late-join floor). |
| `maxParts` | `512` | Parts per message (a big supervisor turn-tree ≈ 100). |
| `maxPartBytes` | `256 KiB` | Accumulated text per part; oversize settles the stream `aborted`. |
| `maxEventsPerAppend` | `256` | Events in one append batch. |
| `project` | root-text join | Derives the settled `content` (see [above](#structured-content)). |

A cap violation settles the stream `aborted` and surfaces `BAD_REQUEST` to the producer — a runaway
producer cannot grow a row forever.

## Lifecycle & failure

- **Author disconnect** auto-aborts the author's open streams, partials preserved; `finalizeMessage.after`
  still fires, so audit never misses an interrupted turn.
- **`chatKit.messages.abort(id, error?)`** is the server-side, un-vetoable **kill-switch** for any open
  stream on that node.
- **`chatKit.messages.sweepStale({ olderThanMs })`** repairs streams orphaned by a **crashed** node
  (disconnect-abort can't fire there). It's host-invoked, never automatic — on a cluster another node's
  stream may be mid-flight, and only the host knows.
- **Graceful `server.close()`** drains open local streams (settles them aborted) while the backend is still
  live — a clean shutdown never strands a `streaming` row.
- **Deleting the channel or message** mid-stream drops the stream and cascades its parts; a still-open
  writer's next `finalize`/`abort` becomes a no-op.

The `finalizeMessage` hook is your moderation/audit seam: its `after` fires on **every** settle — complete,
aborted (including disconnect), and error — with the fully assembled message (`{ ...message, parts }`).
