# Put an automated participant in chat

This tutorial connects an ordinary API-key user, watches one channel, and streams a reply. The chat
plugin supplies authorization and transcript persistence; the application supplies automation policy.

## 1. Create the identity

```ts
const runtimeUser = await authKit.users.create({
  email: "assistant@example.internal",
  displayName: "Assistant",
  metadata: { runtime: "tutorial-assistant" },
});
const { key } = await authKit.apiKeys.create(runtimeUser.id, {
  role: "user",
  label: "tutorial-runtime",
});
```

For a restart-safe service, make this host code find its own metadata marker, reactivate the user if
needed, and rotate keys. These conventions do not belong in plugin-chat. Assign memberships from
server policy, such as a `createChannel.after` hook, and backfill existing channels during startup;
the connected runtime should not grant itself access.

## 2. Connect the same client a human uses

```ts
const raw = createSuperLineClient(app, {
  transport: webSocketClientTransport({ url }),
  role: "user",
  params: { apiKey: key },
});
const automation = chatClient(raw, { userId: runtimeUser.id });
await automation.ready;
```

The client only sees channels, messages, parts, and resources allowed by its memberships.

## 3. Decide which messages trigger work

```ts
const feed = automation.messages(channelId);
await feed.ready;
const handled = new Set(feed.rows().map((message) => message.id));
let queue = Promise.resolve();

feed.subscribe(() => {
  for (const message of feed.rows()) {
    if (handled.has(message.id) || message.status === "streaming") continue;
    handled.add(message.id);
    if (message.authorId === runtimeUser.id) continue;
    if (typeof message.content !== "string") continue;
    queue = queue.then(() => answer(message.content)).catch(console.error);
  }
});
```

This tutorial skips the initial backlog and serializes turns. A production runtime can persist a
cursor and choose different retry/delivery semantics.

## 4. Stream a deterministic reply

```ts
async function answer(prompt: string) {
  const writer = await automation.stream(channelId);
  try {
    writer.push({ type: "part_start", key: "text", partType: "text" });
    for (const word of `You said: ${prompt}`.split(/(?<=\s)/)) {
      if (writer.signal.aborted) throw new Error(String(writer.signal.reason));
      writer.push({ type: "delta", key: "text", text: word });
    }
    writer.push({ type: "part_end", key: "text" });
    await writer.finalize();
  } catch (error) {
    await writer.abort(String(error)).catch(() => {});
    throw error;
  }
}
```

## 5. Render after reload

Use the live envelope window for the feed, then mount a complete parts store for each detailed turn:

```tsx
function Transcript({ channelId }) {
  const messages = useMessages(channelId);
  return messages.map((message) =>
    message.status === undefined ? (
      <Bubble key={message.id} message={message} />
    ) : (
      <StreamedTurn key={message.id} channelId={channelId} message={message} />
    ),
  );
}

function StreamedTurn({ channelId, message }) {
  const parts = useMessageParts(channelId, message.id);
  return <AgentParts parts={parts} status={message.status} />;
}
```

`messageParts()` and `useMessageParts()` return the full durable supervisor/subagent tree for that
message. They do not depend on model memory and are not truncated by a channel-wide part window.

## 6. Swap in the AI SDK

```ts
import { chatAgentTools, pipeUIMessageStream } from "@super-line/plugin-chat/ai-sdk";

const tools = chatAgentTools(raw);
const writer = await automation.stream(channelId);
const result = await agent.stream({ messages: modelInput, tools, abortSignal: writer.signal });
const mapped = await pipeUIMessageStream(writer, result.toUIMessageStream());
await writer.finalize(mapped.error ? { status: "error", error: mapped.error } : {});
```

The adapter interprets AI SDK chunks. The application still owns the trigger loop, model input,
writer lifecycle, and memory.

For a Mastra supervisor with nested subagents, use `createMastraRunner()` the same way. The complete
implementation is in `examples/chat-supervisor`.
