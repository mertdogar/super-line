# @super-line/plugin-chat

A server-authoritative chat backbone for super-line: channels, memberships, message envelopes,
durable streamed parts, resources, and presence. It requires `@super-line/plugin-auth`.

The plugin has no concept of a bot. Humans, services, and agents are ordinary authenticated users
with ordinary channel memberships. A host application owns identity provisioning, trigger policy,
model memory, and response loops.

```bash
pnpm add @super-line/plugin-chat @super-line/plugin-auth
```

## Contract and server

```ts
import { z } from "zod";
import { defineContract } from "@super-line/core";
import { authContract } from "@super-line/plugin-auth";
import { chatContract } from "@super-line/plugin-chat";

const app = defineContract({
  roles: { user: {} },
  plugins: [
    authContract(),
    chatContract({
      content: z.string(),
      data: z.object({ kind: z.literal("progress"), value: z.number() }),
    }),
  ],
});
```

`content` parameterizes message bodies. `data` parameterizes custom durable stream parts. Both
schemas flow through collection rows, requests, client writers, and React hooks.

```ts
import { chat } from "@super-line/plugin-chat/server";

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

createSuperLineServer(app, {
  nodeKey: "chat-replica-1",
  collections: backend,
  authenticate: authKit.authenticate,
  identify: authKit.identify,
  plugins: [authKit.plugin, chatKit.plugin],
});
```

Every mutation is a request. Collections are client-read-only, and membership policies scope
channels, messages, and message parts to the connected user. Hooks wrap the same domain operations
used by client requests and `chatKit` server calls.

## Client reads

```ts
import { chatClient } from "@super-line/plugin-chat/client";

const chat = chatClient(client, { userId });
await chat.ready;

const recent = chat.messages(channelId, { limit: 200 }); // live message envelopes only
const members = chat.members(channelId); // profile + derived connection presence
const page = await chat.history(channelId, { before: cursor, limit: 50 });
const parts = chat.messageParts(channelId, messageId); // complete, tree-ordered, live
```

Member presence expires after 90 seconds by default. Set `presenceTimeoutMs` on `chatClient` when needed, and keep it above the server heartbeat interval. With heartbeats disabled, a connection cannot keep its presence fresh.

The read APIs are deliberately separate:

- `messages()` is a bounded live newest-N envelope window.
- `history()` returns one keyset-paginated envelope snapshot using `{ createdAt, id }`.
- `messageParts()` returns every durable part for one message and overlays live text deltas. Mount
  it only for messages whose detailed transcript is being rendered.
- `members()` joins membership rows with `displayName`, `online`, `connectedAt`, and `lastSeenAt`.

There is no channel-wide parts window and no silent parts truncation. A reload can reconstruct the
entire supervisor and subagent tree for any message.

React bindings expose the same split:

```tsx
const { ChatProvider, useMessages, useChatHistory, useMessageParts } =
  createChatHooks<typeof app>();
```

## Producing a streamed message

```ts
const writer = await chat.stream(channelId);
try {
  writer.push(
    { type: "part_start", key: "answer", partType: "text" },
    { type: "delta", key: "answer", text: "Hello" },
    { type: "part_end", key: "answer" },
  );
  await writer.finalize();
} catch (error) {
  await writer.abort(String(error)).catch(() => {});
  throw error;
}
```

The event vocabulary is plugin-owned:

- `part_start` opens `text`, `reasoning`, `tool`, or host-typed `data` parts.
- `delta` appends text or reasoning.
- `tool_patch` atomically replaces tool args/result/error/state.
- `data_patch` atomically replaces a custom data payload.
- `part_end` closes a part.

Text deltas are ephemeral for smooth rendering and checkpointed into part rows for durability.
Tool and data lifecycle changes persist immediately. `parent` nests a part under a tool call, so a
single message can hold a complete supervisor/subagent tree.

The author or a channel owner can request cancellation:

```ts
await chat.cancelMessage(messageId, "stopped by owner");
writer.signal.addEventListener("abort", stopModel);
```

Cancellation authorization is server-side. It settles the envelope as `aborted` and notifies the
producer signal; it is not represented as a synthetic chat message.

## AI SDK and Mastra adapters

Adapters interpret provider streams but never own chat lifecycle or model history.

```ts
import { pipeUIMessageStream } from "@super-line/plugin-chat/ai-sdk";

const writer = await chat.stream(channelId);
const result = await agent.stream({ messages: modelInput });
const mapped = await pipeUIMessageStream(writer, result.toUIMessageStream(), {
  mapDataPart: (chunk) => (chunk.type === "data-progress" ? { data: chunk.data } : undefined),
});
await writer.finalize(mapped.error ? { status: "error", error: mapped.error } : {});
```

`createUIMessageStreamAdapter()` exposes the stateful interpreter when the host owns the loop.
`chatAgentTools(client)` provides stateless, permission-checked AI SDK tools over that client's own
connection.

```ts
import { createMastraRunner } from "@super-line/plugin-chat/mastra";

const runner = createMastraRunner({
  agent: supervisor,
  subagents: [{ agent: worker }],
});

const writer = await chat.stream(channelId);
const result = await runner.run(writer, modelInput, {
  abortSignal: writer.signal,
  requestContext,
});
await writer.finalize(result.error ? { status: "error", error: result.error } : {});
```

The runner owns Mastra delegation topology, the injected `delegate` tool, lane keys, nesting, and
chunk interpretation. The host still owns the client, channel, input/history, model memory, message
open/finalize/abort policy, and trigger loop. `pipeMastraStream()` and `createChunkAdapter()` are the
single-lane and low-level alternatives.

## Automation is host policy

Provisioning an automation user uses plugin-auth directly:

```ts
const user = await authKit.users.create({
  email: "assistant@example.internal",
  displayName: "Assistant",
  metadata: { runtime: "support-assistant" },
});
const { key } = await authKit.apiKeys.create(user.id, { role: "user", label: "support-runtime" });
```

Connect it with `{ apiKey: key }` and wrap it in the same `chatClient` used by a human. The host then
assigns memberships in server policy—for example, a `createChannel.after` hook can add the user to
every new channel. The connected runtime does not manage its own access. The host also decides which
envelopes trigger work, how turns are serialized, what counts as backlog, and whether model history
comes from Mastra memory, another store, or a projection of chat envelopes.

See `examples/chat-supervisor` for this complete pattern and durable reload rendering.

## Subpaths

- `@super-line/plugin-chat` — contract, schemas, rows, stream event types.
- `@super-line/plugin-chat/server` — `chat()` and the imperative `chatKit`.
- `@super-line/plugin-chat/client` — `chatClient`, history/part helpers, part-tree utilities.
- `@super-line/plugin-chat/react` — React bindings.
- `@super-line/plugin-chat/ai-sdk` — AI SDK tools and stream adapters.
- `@super-line/plugin-chat/mastra` — Mastra stream adapter and delegation runner.

MIT © super-line
