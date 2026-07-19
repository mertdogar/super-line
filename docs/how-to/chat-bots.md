# Run an automated chat client

Plugin-chat does not implement bots. An automated participant is a normal plugin-auth user connected
through the same client and protected by the same membership policies as a human.

The host application owns four decisions:

1. How the user and credential are provisioned.
2. The server-side policy that assigns its channels, and which messages trigger work.
3. Where model memory lives and how model input is constructed.
4. How a model stream is opened, cancelled, finalized, or aborted.

## Provision a standard user

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
```

Idempotence, key rotation, reactivation, and naming conventions are application policy. The
`examples/chat-supervisor` runtime shows one implementation without placing those rules in the plugin.

Keep membership assignment in the server, not in the connected runtime. For example, capture the
provisioned user id and assign it to new channels through `createChannel.after`:

```ts
hooks: {
  createChannel: {
    after: async (channel) => addRuntimeUser(channel.id),
  },
}
```

The host should also backfill existing channels when it registers the runtime user. See
`examples/chat-supervisor/src/server.ts` for the complete startup-safe pattern.

Connect it normally:

```ts
const client = createSuperLineClient(app, {
  transport,
  role: "user",
  params: { apiKey: key },
});
const automation = chatClient(client, { userId: user.id });
await automation.ready;
```

Every collection subscription is restricted by this user's current memberships. Knowing a channel or
message id does not bypass the server's read policy.

## Own the trigger loop

Use `messages(channelId)` as the live envelope window. Your runtime decides how to treat backlog,
resource-card envelopes, messages from other automations, and per-channel concurrency.

```ts
const feed = automation.messages(channelId);
await feed.ready;

const handled = new Set(feed.rows().map((message) => message.id));
let queue = Promise.resolve();

feed.subscribe(() => {
  for (const message of feed.rows()) {
    if (handled.has(message.id) || message.status === "streaming") continue;
    handled.add(message.id);
    if (message.authorId === user.id) continue;
    if (typeof message.content !== "string") continue;
    queue = queue.then(() => respond(channelId)).catch(reportFailure);
  }
});
```

For production processing, persist a host-owned cursor or job record so restarts can resume according
to your delivery semantics. Plugin-chat remains a transcript and authorization layer, not a job queue.

## Choose model history

Chat rendering history and model memory are different concerns. Common policies are:

- Let Mastra Memory own conversation history and pass only the new user input.
- Store model memory in another application database.
- Project a bounded chat history page into model messages.

```ts
const page = await automation.history(channelId, { limit: 50 });
const modelInput = page.messages.flatMap((message) => {
  if (typeof message.content !== "string") return [];
  return [
    {
      role: message.authorId === user.id ? "assistant" : "user",
      content: message.content,
    },
  ];
});
```

Plugin-chat does not infer assistant roles, remove resource cards, or decide which parts belong in
model context. Those choices vary by application.

## AI SDK

`chatAgentTools(client)` is a stateless toolset over the connected user's own permissions.

```ts
import { chatAgentTools, pipeUIMessageStream } from "@super-line/plugin-chat/ai-sdk";

const tools = chatAgentTools(client);
const writer = await automation.stream(channelId);
try {
  const result = await agent.stream({ messages: modelInput, tools });
  const mapped = await pipeUIMessageStream(writer, result.toUIMessageStream(), {
    mapDataPart: (chunk) => (chunk.type === "data-progress" ? { data: chunk.data } : undefined),
  });
  await writer.finalize(mapped.error ? { status: "error", error: mapped.error } : {});
} catch (error) {
  await writer.abort(String(error)).catch(() => {});
  throw error;
}
```

`createUIMessageStreamAdapter()` exposes the stateful chunk interpreter for custom loops.
`onUnsupported` can observe provider chunks that the host chose not to persist.

## Mastra supervisor and subagents

```ts
import { createMastraRunner } from "@super-line/plugin-chat/mastra";

const runner = createMastraRunner({
  agent: supervisor,
  subagents: [{ agent: worker }, { agent: editor }],
  maxDepth: 3,
});

const writer = await automation.stream(channelId);
try {
  const result = await runner.run(writer, modelInput, {
    abortSignal: writer.signal,
    requestContext,
  });
  await writer.finalize(result.error ? { status: "error", error: result.error } : {});
} catch (error) {
  await writer.abort(String(error)).catch(() => {});
  throw error;
}
```

The runner owns only Mastra-specific interpretation and delegation mechanics:

- injecting the `delegate` tool;
- validating delegation edges and depth;
- namespacing supervisor/subagent lanes;
- nesting child parts beneath the delegate tool part;
- mapping Mastra chunks and propagating abort.

It does not know a chat client, channel, membership, transcript history, or response policy. Per-agent
provider options and memory remain on each Mastra `Agent`.

## Reload the complete execution transcript

The message envelope and model memory do not contain the subagent progress tree. Plugin-chat persists it
as `messageParts`:

```ts
const envelopes = await automation.history(channelId, { limit: 50 });
const parts = automation.messageParts(channelId, messageId);
await parts.ready;
render(parts.rows());
```

`messageParts()` is complete for that message. It has no hidden 1,000-part window, and its parent/tool
relationships survive reload.

## Cancellation

The author and channel owners can cancel a running message:

```ts
await automation.cancelMessage(messageId, "cancelled by user");
```

The producer's `writer.signal` aborts, partial parts remain durable, and the envelope settles as
`aborted`. Feed that signal into the model runtime; do not encode cancellation as a chat message.
