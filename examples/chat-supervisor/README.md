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
- **The harness event mapping, preserved.** `src/chunk-adapter.ts` is a direct port of
  super-harness's Mastra `fullStream` chunk-adapter (same `ChunkLike` view, same stateful
  per-lane mapper with `suppressToolNames`, same case vocabulary) — only the output vocabulary
  changed, from `HarnessEvent`s to plugin-chat stream events. The same mapper runs at every
  depth, so subagents stream with full fidelity.
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
- `src/agents.ts` — Mastra `worker` (weather tool) + `supervisor` (delegate tool, harness-shaped
  `{ agentType, task } → { content, isError }`).
- `src/chunk-adapter.ts` — the ported mapper: Mastra chunks → plugin-chat stream events, per lane
  (`prefix` + `parent`).
- `src/runtime.ts` — the bot: watches `#agents`, answers each human message as one streamed
  message; the delegate tool's `execute()` streams the worker's lane into the same writer with
  `parent = the delegate call's tool part`.
- `src/components/chat.tsx` — the feed: tree-ordered parts folded into delegation cards.
