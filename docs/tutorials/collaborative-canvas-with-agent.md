# Build a collaborative canvas with an automated editor

This pattern combines a host-owned CRDT collection, plugin-chat resources, and an ordinary automated
member. Humans edit through live document handles; the automation uses the acknowledged resource write
request so validation failures are explicit.

## Declare the document and chat contract

```ts
const canvasSchema = z.object({
  title: z.string(),
  items: z.record(z.string(), z.object({
    x: z.number(),
    y: z.number(),
    color: z.string(),
    text: z.string(),
  })).catch({}),
})

const app = defineContract({
  collections: {
    canvases: { schema: canvasSchema, crdt: { mode: 'document' } },
  },
  roles: { user: {} },
  plugins: [authContract(), chatContract()],
})
```

Register a channel resource kind on the server:

```ts
const chatKit = chat({
  contract: app,
  resources: {
    kinds: {
      canvas: {
        collection: 'canvases',
        lifecycle: 'linked',
        init: () => ({ title: 'Canvas', items: {} }),
      },
    },
  },
})
```

Registration contributes membership-scoped policies for the CRDT collection. Do not add a second
host policy for the same collection.

## Attach the canvas

```ts
const resource = await chat.createResource(channelId, {
  kind: 'canvas',
  id: projectId,
  title: 'Project canvas',
})
```

Humans open `resource.collection/resource.docId` with the normal super-line document API. The chat
resource row is the channel-to-document registry.

## Add a standard automation member

```ts
const editorUser = await authKit.users.create({
  email: 'canvas-editor@example.internal',
  displayName: 'Canvas Editor',
  metadata: { runtime: 'canvas-editor' },
})
const { key } = await authKit.apiKeys.create(editorUser.id, {
  role: 'user',
  label: 'canvas-editor-runtime',
})
await chatKit.members.add(channelId, editorUser.id)

const raw = createSuperLineClient(app, {
  transport,
  role: 'user',
  params: { apiKey: key },
  crdtCollections,
})
const editor = chatClient(raw, { userId: editorUser.id })
```

There is no bot-specific chat API. Identity rotation, membership assignment, and trigger behavior are
application code.

## Give the model permission-checked resource tools

```ts
import { chatAgentTools } from '@super-line/plugin-chat/ai-sdk'

const tools = chatAgentTools(raw, {
  resourceShapes: {
    canvas: '{ title: string, items: Record<id, { x, y, color, text }> }',
  },
})
```

These tools run through the editor user's connection. Membership policies and server validation still
apply. `write_resource` returns an acknowledged result or a structured error.

## Choose the trigger policy

```ts
const feed = editor.messages(channelId)
await feed.ready
const handled = new Set(feed.rows().map((message) => message.id))

feed.subscribe(() => {
  for (const message of feed.rows()) {
    if (handled.has(message.id) || message.status === 'streaming') continue
    handled.add(message.id)
    if (message.authorId === editorUser.id) continue
    if (message.metadata?.resource) continue
    if (typeof message.content !== 'string') continue
    queueEdit(message.content)
  }
})
```

Resource cards are standard envelopes; this runtime explicitly ignores them. Another application may
use them as triggers.

## Stream the editor's turn

```ts
import { pipeUIMessageStream } from '@super-line/plugin-chat/ai-sdk'

const writer = await editor.stream(channelId)
try {
  const result = await agent.stream({
    messages: modelInput,
    tools,
    abortSignal: writer.signal,
  })
  const mapped = await pipeUIMessageStream(writer, result.toUIMessageStream())
  await writer.finalize(mapped.error ? { status: 'error', error: mapped.error } : {})
} catch (error) {
  await writer.abort(String(error)).catch(() => {})
  throw error
}
```

The model's reasoning and resource tool calls persist as message parts. On reload, render the envelope
from `messages()`/`history()` and mount `messageParts(channelId, messageId)` to recover the complete
execution transcript.

See `examples/chat-supervisor` for nested Mastra delegations and live resource presence.
