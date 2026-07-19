# Chat supervisor example

A Mastra supervisor delegates to worker/editor agents while plugin-chat persists the complete turn
tree. Reload the web or TUI client and every reasoning, tool, delegate, and subagent part is still
available.

## What this demonstrates

- The supervisor runtime is an ordinary plugin-auth user with an API key and ordinary memberships.
- `src/server.ts` owns membership policy: a `createChannel.after` hook assigns the supervisor to every
  new channel and startup registration backfills existing channels.
- User provisioning, key rotation, channel triggers, backlog policy, and per-channel serialization
  live in application code, not plugin-chat.
- `createMastraRunner()` owns only Mastra delegation topology, lane nesting, chunk interpretation,
  and abort propagation.
- `messages()` supplies live message envelopes; `messageParts()`/`useMessageParts()` supplies the
  complete detailed transcript for one message.
- Per-lane token usage (0.6.0): the runtime's `mapDataPart` turns each lane's Mastra `finish` chunk
  into a typed `usage` data part — the supervisor and every subagent report their own token chip in
  the web and TUI transcripts, and the headless `<<TURN_DONE>>` marker carries the turn total.
- Explicit cancellation: `/cancel` (cockpit and headless shell alike) or the web stop button settles
  the turn `aborted` server-side and unwinds the model run via `writer.signal` — the runtime never
  finalizes after a cancel (the settle contract,
  [0.5 migration guide §10](../../docs/how-to/plugin-chat-0-5-migration.md#_10-wire-explicit-cancellation)).
- Shared canvas/doc resources are host-owned CRDT collections protected by channel membership.
- Browser, TUI, headless client, and automation all use standard super-line clients.

## Run

```bash
pnpm --filter @super-line/example-chat-supervisor dev
```

Open the printed web URL. Without `AI_GATEWAY_API_KEY`, the runtime posts a configuration message.
With a key, try:

- `compare the weather in Ankara and Berlin`
- `add three sprint-goal notes to the canvas`
- `summarize the doc`

Optional environment variables:

```bash
AI_GATEWAY_API_KEY=...
MODEL=anthropic/claude-haiku-4.5
PORT=8792
```

The example uses local SQLite files for message/resource durability.

## Relevant files

- `src/server.ts` — host-owned membership assignment policy.
- `src/runtime.ts` — standard-user provisioning, trigger loop, model input, and writer lifecycle.
- `src/agents.ts` — plain Mastra agents and resource tools.
- `src/components/chat.tsx` — envelope feed plus lazy complete message-part rendering.
- `src/tui/` — the same architecture in OpenTUI and headless JSONL modes.
