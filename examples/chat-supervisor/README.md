# chat-supervisor — a Mastra supervisor + subagent, no harness

The [super-harness](https://github.com/mertdogar/super-harness) `examples/web` flow rebuilt on
**super-line alone**: a Mastra **supervisor** agent that must delegate real-world lookups to a
**worker** subagent (live Open-Meteo weather tool), with the WHOLE turn — the supervisor's text,
the delegation, and the worker's own tool calls, retries, and report — streaming into a
`@super-line/plugin-chat` channel as **one streamed message** (ADR-0011).

What it demonstrates:

- **Subagent turns render as their own cards.** A delegation's tool part is the card anchor; the
  worker's lane (`parent`-nested parts) streams inside it, with a live status badge
  (running → completed/error). Multiple delegations = multiple cards in one message.
- **Everything survives reload.** Parts are rows, checkpointed ~1s while streaming — reload
  mid-turn and the cards re-render from the database, then keep streaming. No ephemeral-only
  state anywhere.
- **The wiring is three library calls.** `@super-line/plugin-chat/mastra`'s `mastraEngine` takes
  the two PLAIN Mastra agents and owns everything this example used to hand-roll: the `delegate`
  tool (injected per stream call via toolsets — the agents never declare it), the lanes and
  `parent` nesting, and the harness-ported chunk mapping (the same mapper runs at every depth, so
  subagents stream with full fidelity). `provisionChatBot` mints the identity;
  `onChatMessage` runs the channel loop, turns serialized per channel.
- **Reasoning streams too.** Both agents enable Anthropic extended thinking via `defaultOptions`
  on their own plain Agent (Mastra merges it under the engine's per-lane options, so workers think
  inside their cards as well); thinking tokens land as `reasoning` parts, auto-opened while live.
- **The bot is a regular user** (plugin-auth API key) on the same WebSocket wire as the browser.

## Run it

```bash
pnpm install                       # repo root
cd examples/chat-supervisor
echo 'AI_GATEWAY_API_KEY=…' > .env # Vercel AI Gateway key (also read from ../collections-chat/.env)
pnpm dev                           # server on :8792 + vite on :5173x
```

Sign up, and ask something that needs live data — e.g. *“compare the weather in Ankara and
Berlin”* — then watch the supervisor delegate. Reload mid-stream to see the durable floor.

`MODEL` (default `anthropic/claude-haiku-4.5`) picks the gateway model for both agents.

## Layout

- `src/contract.ts` — the app IS the two plugins: `plugins: [authContract(), chatContract()]`.
- `src/agents.ts` — two vanilla Mastra agents: `worker` (weather tool) + `supervisor`. No
  factories, no delegate tool — the engine injects it.
- `src/runtime.ts` — the whole bot: `provisionChatBot` (identity) + `mastraEngine` (the
  delegation tree → one streamed message) + `onChatMessage` (the channel loop).
- `src/components/chat.tsx` — the feed: tree-ordered parts folded into delegation cards.
