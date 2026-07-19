# Stream a complete turn

A streamed message has one envelope in `messages` and an ordered set of durable rows in
`messageParts`. Parts may be `text`, `reasoning`, `tool`, or a host-defined `data` payload. Tool
parents let one message preserve an entire supervisor/subagent execution tree.

## Write lifecycle

```ts
const writer = await chat.stream(channelId)
try {
  writer.push(
    { type: 'part_start', key: 'answer', partType: 'text' },
    { type: 'delta', key: 'answer', text: 'Hello ' },
    { type: 'delta', key: 'answer', text: 'world' },
    { type: 'part_end', key: 'answer' },
  )
  await writer.finalize()
} catch (error) {
  await writer.abort(String(error)).catch(() => {})
  throw error
}
```

Client writers queue and micro-batch events. `flush()` exposes any wire or server error early.
Server writers from `chatKit.messages.stream({ channelId, authorId })` use the same vocabulary but
apply events immediately.

| Event | Meaning |
| --- | --- |
| `part_start` | Open a text, reasoning, tool, or typed data part. |
| `delta` | Append text to a text/reasoning part. |
| `tool_patch` | Replace tool args, result, error flag, or state. |
| `data_patch` | Replace the host-typed data payload. |
| `part_end` | Close the part; optional final text heals missed deltas. |

Tool state is monotonic: `input-streaming → running → done`.

## Durable and live reads

Message envelopes and detailed parts are intentionally separate:

```ts
const recent = chat.messages(channelId, { limit: 200 })
const page = await chat.history(channelId, { before: cursor, limit: 50 })
const parts = chat.messageParts(channelId, messageId)
```

- `messages()` is the bounded live recent window.
- `history()` is a one-shot keyset page of older envelopes.
- `messageParts()` is complete for one message, tree-ordered, and live. It overlays ephemeral text
  deltas on the last durable checkpoint.

This split keeps channel feeds cheap without ever truncating a selected message's execution history.
After reload, mounting `messageParts()` reconstructs every supervisor and subagent part from rows.

React exposes `useMessages`, `useChatHistory`, and `useMessageParts` with the same responsibilities.

## Typed data parts

Declare the host payload at contract time:

```ts
const app = defineContract({
  plugins: [
    authContract(),
    chatContract({ data: z.object({ kind: z.literal('progress'), value: z.number() }) }),
  ],
})
```

Then writers and readers are typed:

```ts
writer.push({
  type: 'part_start',
  key: 'progress',
  partType: 'data',
  data: { kind: 'progress', value: 10 },
})
writer.push({ type: 'data_patch', key: 'progress', data: { kind: 'progress', value: 100 } })
```

Structured payloads replace atomically and are limited by `maxStructuredBytes`.

## Supervisor trees

The `parent` field names an existing tool call:

```ts
writer.push({ type: 'part_start', key: 'call-42', partType: 'tool', toolName: 'delegate' })
writer.push({ type: 'part_start', key: 'worker-text', partType: 'text', parent: 'call-42' })
writer.push({ type: 'delta', key: 'worker-text', text: 'Worker result' })
writer.push({ type: 'part_end', key: 'worker-text' })
writer.push({ type: 'tool_patch', key: 'call-42', result: { content: 'Worker result' } })
writer.push({ type: 'part_end', key: 'call-42' })
```

`messageParts()` returns tree order. `buildPartTree(parts)` returns an explicit nested structure;
`partsText(parts, parent)` extracts text from one lane.

## Stream adapters

```ts
import { pipeUIMessageStream } from '@super-line/plugin-chat/ai-sdk'
import { pipeMastraStream } from '@super-line/plugin-chat/mastra'
```

Both map provider chunks into plugin events and never open or settle messages. Use
`createUIMessageStreamAdapter()` or `createChunkAdapter()` when the host owns the iteration loop.
`mapDataPart` converts provider-specific file/source/data/usage chunks into the contract's typed data
payload; `onUnsupported` lets the host observe anything intentionally not persisted.

## Cancellation

```ts
await chat.cancelMessage(messageId, 'user stopped generation')
writer.signal.addEventListener('abort', () => modelAbort.abort())
```

Only the author or a channel owner may cancel. The server settles the message `aborted`, preserves
partial parts, and signals the producer. Cancellation is control flow, not a fake transcript message.

## Limits

Configure with `chat({ streaming: { … } })`:

| Option | Default |
| --- | --- |
| `checkpointMs` | `1000` |
| `maxParts` | `512` |
| `maxTextBytes` | `256 KiB` |
| `maxStructuredBytes` | `256 KiB` |
| `maxEventsPerAppend` | `256` |

`project(parts)` derives the settled envelope `content`; by default root text parts are joined with
blank lines. Hosts with structured content schemas should provide a matching projection.

Disconnect, shutdown, explicit abort, and stale-stream sweeping preserve partial durable parts and
settle envelopes honestly.
