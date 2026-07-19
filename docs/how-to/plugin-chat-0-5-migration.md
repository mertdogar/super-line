# Migrate plugin-chat from 0.4 to 0.5

`@super-line/plugin-chat` 0.5 is a clean architectural break from 0.4. It
preserves the chat domain model, but removes bot policy from the plugin, splits
message envelopes from detailed streamed parts, and makes complete supervisor
and subagent execution history durable across reloads.

This guide explains why the architecture changed, maps the removed APIs to
their replacements, and walks you through migrating a 0.4 application.

## Why 0.5 exists

Version 0.4 combined several concerns that don't belong to the same layer. The
plugin assembled channel-wide message and part feeds, provisioned bot users,
selected trigger messages, built model history, and settled model responses.
That made a simple demo convenient, but made generic applications harder to
secure, scale, and customize.

Version 0.5 establishes these boundaries:

- Plugin-chat owns chat authorization, message envelopes, durable streamed
  parts, live deltas, resources, and cancellation.
- Your host application owns identity provisioning, channel assignment,
  trigger policy, delivery semantics, model memory, and response lifecycle.
- AI SDK and Mastra adapters only translate provider chunks into plugin-chat
  stream events.
- Humans, services, and agents use the same authenticated client and membership
  model.

The result supports Tomorrow's supervisor workflow without making that
workflow part of the generic chat library.

## The new responsibility boundary

Use this ownership model when you decide where new behavior belongs.

| Concern                                 | Owner                    |
| --------------------------------------- | ------------------------ |
| Channel and membership authorization    | Plugin-chat server       |
| Membership assignment policy            | Host server              |
| Message envelopes and durable parts     | Plugin-chat              |
| Live text and reasoning deltas          | Plugin-chat              |
| User and API key provisioning           | Host through plugin-auth |
| Message trigger and backlog policy      | Host runtime             |
| Model input and memory                  | Host or model framework  |
| Provider chunk interpretation           | AI SDK or Mastra adapter |
| Open, finalize, abort, and retry policy | Host runtime             |
| Transcript rendering                    | Application UI           |

Two histories now remain intentionally separate:

- **Render history** is the durable message envelope plus its `messageParts`.
  It reconstructs reasoning, tool calls, delegation, and subagent progress
  after a reload.
- **Model history** is the context you send to the model. Mastra Memory, an
  application database, or a bounded projection of chat envelopes can own it.

Don't use model memory as the source for transcript rendering. Model frameworks
may omit intermediate subagent progress, while plugin-chat persists the exact
part tree that the UI needs.

## Breaking changes at a glance

The following table maps the main 0.4 APIs to their 0.5 replacements.

| 0.4                                            | 0.5                                                         |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `@super-line/plugin-chat/ai`                   | `@super-line/plugin-chat/ai-sdk`                            |
| `provisionChatBot()`                           | Host-owned plugin-auth user and API key provisioning        |
| `onChatMessage()`                              | Host-owned envelope subscription and trigger loop           |
| `mastraEngine()`                               | `createMastraRunner()`                                      |
| `engine.respond(chat, channel, history)`       | Open writer, call `runner.run()`, then settle writer        |
| `ChatTurnMessage`                              | The model framework's message type, built by the host       |
| `AssembledMessageOf`                           | Message envelope plus a separate message-parts store        |
| `messages(channel, { partsLimit, streaming })` | `messages()`, `history()`, and `messageParts()`             |
| `partsLimit`                                   | Removed; one selected message always returns complete parts |
| `part_patch`                                   | `tool_patch`                                                |
| `maxPartBytes`                                 | `maxTextBytes` and `maxStructuredBytes`                     |
| Channel-wide parts subscription                | Lazy per-message `messageParts()` subscription              |

Version 0.5 also adds typed `data` parts, `data_patch`, explicit cancellation,
keyset history pagination, `useChatHistory()`, `useMessageParts()`, and
provider-stream adapter factories.

## Migrate your application

Complete the following steps in order. The examples use plain-text message
content, but the same flow works with a host-defined content schema.

### 1. Update the dependency

Install the new minor version. This release intentionally contains breaking
changes because the package is still below 1.0.

```bash
pnpm add @super-line/plugin-chat@^0.5.0
```

### 2. Decide how to handle existing chat data

The `messageParts` row schema changed from one permissive shape to a
discriminated union. Tool parts now require their tool state, text fields only
exist on text and reasoning parts, and contracts may define typed data parts.

Version 0.5 does not include an automatic data migration. During development,
reset the chat collections together so message envelopes and parts remain
consistent. If you must retain production transcripts, transform existing
`messageParts` rows before starting the 0.5 server.

At minimum, a retained migration must:

- keep `text` and `offset` only on `text` and `reasoning` rows;
- keep tool fields only on `tool` rows;
- populate `toolCallId` and `state` for every tool row; and
- preserve `messageId`, `channelId`, `idx`, `parent`, `done`, and
  `lastActivityAt`.

### 3. Define typed data parts when you need them

Pass a `data` schema to `chatContract()` when provider-specific information
must survive reloads. Omit it when your application only stores text,
reasoning, and tool parts; the default is `z.never()`.

```ts
const progressPart = z.object({
  kind: z.literal("progress"),
  completed: z.number(),
  total: z.number(),
});

export const app = defineContract({
  roles: { user: {} },
  plugins: [
    authContract(),
    chatContract({
      content: z.string(),
      data: progressPart,
    }),
  ],
});
```

The data type flows through collection rows, stream writers, adapters, client
stores, and React hooks. Prefer a typed data part over an unvalidated metadata
convention when the value belongs to the durable execution transcript.

### 4. Split envelope reads from detailed-part reads

In 0.4, `messages()` assembled envelopes and a bounded channel-wide parts
window. A sufficiently old or sufficiently large streamed message could lose
its detailed parts from the client window and fall back to its projected
content.

In 0.5, use one API for each read pattern:

```ts
const recent = chat.messages(channelId, { limit: 200 });
const older = await chat.history(channelId, {
  before: cursor,
  limit: 50,
});
const parts = chat.messageParts(channelId, messageId);

await parts.ready;
renderMessage(message, parts.rows());
```

The APIs have distinct guarantees:

- `messages()` maintains a bounded, live, chronological envelope window.
- `history()` returns a one-shot, keyset-paginated envelope page.
- `messageParts()` returns every durable part for one message in tree order and
  overlays any live text deltas.

Mount `messageParts()` only for a message whose details are visible. This keeps
the channel feed cheap while guaranteeing that an expanded supervisor turn has
no hidden part cap.

React applications use the same split:

```tsx
const history = useChatHistory(channelId, {
  liveLimit: 200,
  pageSize: 50,
});
const parts = useMessageParts(channelId, messageId);
```

Use `buildPartTree(parts)` when your renderer needs explicit nested nodes. Use
`partsText(parts, parent)` when it only needs the text for one lane.

### 5. Update custom stream events and limits

Replace `part_patch` with the specific event for the part type. Structured
values replace atomically; text and reasoning continue to append through
`delta`.

```ts
writer.push(
  {
    type: "part_start",
    key: "call-weather",
    partType: "tool",
    toolName: "weather",
  },
  {
    type: "tool_patch",
    key: "call-weather",
    args: { city: "Berlin" },
    state: "running",
  },
  {
    type: "tool_patch",
    key: "call-weather",
    result: { temperature: 21 },
    state: "done",
  },
  { type: "part_end", key: "call-weather" },
);
```

For typed host data, start the data part with a valid payload and update it
with `data_patch`:

```ts
writer.push({
  type: "part_start",
  key: "progress",
  partType: "data",
  data: { kind: "progress", completed: 0, total: 4 },
});

writer.push({
  type: "data_patch",
  key: "progress",
  data: { kind: "progress", completed: 4, total: 4 },
});
```

Replace the old shared byte ceiling with explicit text and structured-value
limits:

```ts
const chatKit = chat({
  contract: app,
  streaming: {
    checkpointMs: 1_000,
    maxParts: 512,
    maxTextBytes: 256 * 1024,
    maxStructuredBytes: 256 * 1024,
    maxEventsPerAppend: 256,
  },
});
```

If your message content is structured, continue to provide
`streaming.project`. The default projection joins root text parts and only
matches the default `z.string()` content schema.

### 6. Move automation policy into the host

Remove `provisionChatBot()` and `onChatMessage()`. Provision an ordinary
plugin-auth user, connect it with an API key, and build the trigger loop in your
application runtime.

```ts
const user = await authKit.users.create({
  email: "assistant@example.internal",
  displayName: "Assistant",
  metadata: { runtime: "support-assistant" },
});

const { key } = await authKit.apiKeys.create(user.id, {
  role: "user",
  label: "support-runtime",
});

const automation = chatClient(client, { userId: user.id });
await automation.ready;
```

Your runtime now decides which envelopes trigger work, how to skip its own
messages and resource cards, whether to process backlog, and how to serialize
turns per channel. Persist a cursor or job record when your delivery semantics
must survive a process restart; plugin-chat is a transcript and authorization
layer, not a job queue.

### 7. Assign memberships from the server

Don't place automatic membership rules in a connected automation or UI client.
Keep those assignments in host server policy. A human may still request to join
a public channel when your product permits public self-join. Hooks run for both
client requests and imperative `chatKit` calls, so `createChannel.after` covers
every channel-creation path.

```ts
let automationUserId: string | undefined;
let chatKit!: ReturnType<typeof chat<typeof app>>;

const addAutomation = async (channelId: string): Promise<void> => {
  if (!automationUserId) return;

  await chatKit.members.add(channelId, automationUserId).catch((error) => {
    if ((error as { code?: string }).code !== "CONFLICT") throw error;
  });
};

chatKit = chat({
  contract: app,
  hooks: {
    createChannel: {
      after: async (channel) => addAutomation(channel.id),
    },
  },
});

const registerAutomationUser = async (userId: string): Promise<void> => {
  automationUserId = userId;

  for (const channel of await chatKit.channels.find()) {
    await addAutomation(channel.id);
  }
};
```

Register the automation user before accepting external traffic when possible.
The existing-channel backfill closes the startup gap and makes restarts
idempotent. Catch only `CONFLICT`; a real membership failure must remain
visible. The connected runtime receives its credential, not `chatKit`.

Membership-based read policies continue to isolate channels. Knowing a channel,
message, part, or resource identifier does not grant read access.

### 8. Migrate AI SDK stream handling

Change the import path and keep message lifecycle in your host code. The
adapter accepts a `StreamEventSink`, so it works with client writers, server
writers, tests, and custom sinks.

```ts
import { chatAgentTools, pipeUIMessageStream } from "@super-line/plugin-chat/ai-sdk";

const writer = await automation.stream(channelId);

try {
  const result = await agent.stream({
    messages: modelInput,
    tools: chatAgentTools(client),
  });
  const mapped = await pipeUIMessageStream(writer, result.toUIMessageStream(), {
    mapDataPart: (chunk) => (chunk.type === "data-progress" ? { data: chunk.data } : undefined),
  });

  await writer.finalize(mapped.error ? { status: "error", error: mapped.error } : {});
} catch (error) {
  await writer.abort(String(error)).catch(() => {});
  throw error;
}
```

Use `createUIMessageStreamAdapter()` when your host owns the chunk iteration
loop. Use `mapDataPart` for provider-specific data, source, file, or usage
chunks that belong in the durable transcript. Use `onUnsupported` to observe
chunks that you intentionally don't persist.

Since 0.6.0 both adapters (AI SDK and Mastra) offer otherwise-dropped framing
chunks (`finish`, `step-finish` / `finish-step`, `message-metadata`, …) to
`mapDataPart` before discarding them — usage riding a finish chunk is mappable
into a durable data part with no host-side smuggling, per lane. Unmapped
framing still drops silently, never hitting `onUnsupported`. Note for existing
hosts: a catch-all `mapDataPart` now sees framing chunks it previously didn't.

### 9. Migrate Mastra supervisors and subagents

Replace `mastraEngine()` with `createMastraRunner()`. The runner owns Mastra
delegation mechanics, but doesn't know about a chat client, channel,
membership, transcript history, or response policy.

```ts
import { createMastraRunner } from "@super-line/plugin-chat/mastra";

const runner = createMastraRunner({
  agent: supervisor,
  subagents: [{ agent: researcher }, { agent: editor }],
});

const writer = await automation.stream(channelId);

try {
  const result = await runner.run(writer, modelInput, {
    abortSignal: writer.signal,
    requestContext: { channelId },
  });

  await writer.finalize(result.error ? { status: "error", error: result.error } : {});
} catch (error) {
  await writer.abort(String(error)).catch(() => {});
  throw error;
}
```

The runner persists the complete delegation tree beneath tool parents. On
reload, `messageParts()` returns the supervisor reasoning, delegate tool,
subagent reasoning, subagent tools, and final text in the same tree order.

Use `pipeMastraStream()` for one lane without delegation. Use
`createChunkAdapter()` when the host owns the iteration loop.

### 10. Wire explicit cancellation

Forward the writer's signal into the model runtime. The message author or a
channel owner may request cancellation through the client.

```ts
const writer = await automation.stream(channelId);

const stopGeneration = () => automation.cancelMessage(writer.messageId, "Stopped by user");

const result = await runner.run(writer, modelInput, {
  abortSignal: writer.signal,
});
```

Cancellation preserves partial durable parts, settles the envelope as
`aborted`, and signals the producer. Don't represent cancellation as a
synthetic chat message.

The settle happens server-side when the cancel lands: the producer must NOT
call `finalize()` after a cancel — the row is already settled and the call is
at best a CONFLICT no-op. Stop pushing and let `writer.signal` unwind the
model run. The same invariant covers deletion (0.6.0): a streamed message
always settles before it vanishes — deleting it (or its channel) mid-stream
settles `aborted` first and releases the producer's stream handle
automatically.

## Best practices after migration

Apply these rules to new plugin-chat integrations, including non-agent use
cases.

- Treat every human, service, and agent as a standard authenticated client.
- Keep identity provisioning and membership assignment in host server code.
- Use hooks for domain policy that must cover client and server operations.
- Read channel feeds as envelopes and mount detailed parts lazily per message.
- Use `history()` for pagination, not an ever-growing live subscription.
- Keep render history separate from model memory and model input projection.
- Persist trigger cursors in the host when restart-safe processing matters.
- Let adapters translate streams, but let the host open and settle messages.
- Pass `writer.signal` into every cancellable model or agent operation.
- Store durable provider extensions as contract-typed data parts.
- Catch only expected idempotency conflicts in membership hooks.
- Keep transcript rendering generic over text, reasoning, tool, and data parts.

## Migration checklist

Verify each item before you remove your 0.4 compatibility code.

- [ ] Upgrade `@super-line/plugin-chat` to 0.5.
- [ ] Reset or migrate persisted `messageParts` rows.
- [ ] Replace the `/ai` import path with `/ai-sdk`.
- [ ] Remove `provisionChatBot()` and `onChatMessage()`.
- [ ] Replace `mastraEngine()` with `createMastraRunner()`.
- [ ] Replace assembled message reads with envelopes plus `messageParts()`.
- [ ] Replace `partsLimit` with lazy, complete per-message part reads.
- [ ] Replace `part_patch` with `tool_patch`.
- [ ] Split `maxPartBytes` into text and structured-value limits.
- [ ] Move membership assignment into server hooks and startup backfill.
- [ ] Decide where model memory and trigger cursors live.
- [ ] Forward `writer.signal` and expose authorized cancellation.
- [ ] Render a stored supervisor turn after a full page reload.
- [ ] Test that a nonmember can't read channels, messages, parts, or resources.

## Related documentation

Continue with the focused guides for the part of the migration you're
implementing:

- [Chat backbone](./plugin-chat.md) explains the core domain and authorization
  model.
- [Stream a complete turn](./chat-streaming.md) documents the durable part
  protocol.
- [Run an automated chat client](./chat-bots.md) shows host-owned trigger and
  memory policy.
- [Attach channel resources](./chat-resources.md) covers membership-gated CRDT
  documents.
- [Chat supervisor example](https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor)
  provides a complete Mastra supervisor implementation.
