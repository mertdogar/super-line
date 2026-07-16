# PLAN-chat-mastra — first-class Mastra hookup for plugin-chat

**Status: CONFIRMED 2026-07-17 (all 4 decisions settled — see bottom) — building.**

## Problem

`examples/chat-supervisor` proves streamed delegation trees work, but its wiring is the opposite of
intuitive: the app developer hand-writes ~330 lines that super-harness gives its users for free.
Today a plugin-chat user hooking up a Mastra agent must own:

1. `chunk-adapter.ts` — the Mastra fullStream → `ChatStreamEvent` mapper (a *ported file* living in
   the example).
2. A bespoke `makeDelegateTool` **closed over the turn's writer**, which forces agent *factories*
   (`makeSupervisor(delegate)`) instead of plain `new Agent({...})` — the single deepest
   unintuitiveness.
3. Two `for await (… of stream.fullStream)` loops, lane prefixes (`s:` / `w:${toolCallId}:`),
   parent anchors, `end()` tail flushes, non-throwing `adapter.error` checks.
4. The finalize/abort settle dance, history assembly (`[status — no text]` placeholders), the
   channel watch/seen-set loop, and bot provisioning (user + API key + membership).

The bar is super-harness (`packages/core/src/harness/harness.ts`): plain Mastra `Agent`s in,
`createHarness({ supervisor, subagents: [{ agent: worker }] })`, `plugins: [harness(engine)]` —
zero streaming code. Its trick: the `delegate` tool + a per-node runtime are injected **per stream
call** via Mastra `toolsets` and a `requestContext` key (`HARNESS_RUNTIME_KEY`), so the user's
agents stay pure and the library owns the loop (`runNode`), the mapper (`createChunkAdapter`), and
delegation (`#spawnChild`, edges + depth gates).

## Design principles

1. **Mastra-first surface, harness-parity internals.** Plain `Agent` in; the delegate tool is
   injected per-call via `toolsets: { chat: { delegate } }` + `rc.set(CHAT_RUNTIME_KEY, runtime)`
   — ported from harness `tools.ts`/`runtime.ts`/`createHarness`'s runner factory. No agent
   factories, no writer-closures in user code.
2. **The chunk mapping stays the harness-mapper port.** The example's `chunk-adapter.ts` (the
   structure the user explicitly wants preserved) moves into the library unchanged in vocabulary:
   text/reasoning segmentation at tool boundaries, suppression bookkeeping, `tool-error` →
   `part_patch{isError}`, turn-level `error` captured not thrown, `tool-call-delta` kept-but-empty.
3. **Bots stay regular users over the wire** (settled: AI agents = users with API keys). So unlike
   harness's server plugin, the binding is *client-side* — which makes it out-of-process capable by
   construction (only needs url + API key; the OMMA ask).
4. **Scope fence.** No approvals/permissions, no ask_user suspension/resume, no modes, no follow-up
   queue/steer, no Mastra Memory threads, no tracing, no usage events. Those are super-harness's
   cockpit. This is exactly: *stream a Mastra delegation tree into one chat message*. Channels are
   the threads; parts rows are the persistence.

## New surface

### `@super-line/plugin-chat/mastra` — new subpath (mirrors `/ai`: `@mastra/core` optional peer)

```ts
import { mastraEngine } from '@super-line/plugin-chat/mastra'

const worker = new Agent({ id: 'worker', instructions: …, model: …, tools: { weather } })  // plain Mastra
const supervisor = new Agent({ id: 'supervisor', instructions: …, model: … })              // no delegate tool here

const engine = mastraEngine({
  agent: supervisor,
  subagents: [{ agent: worker }],   // per-entry: delegatesTo?: string[] | true, maxSteps?
  delegatesTo?: string[] | true,    // supervisor's edges; default = all subagents
  maxSteps?: number,                // supervisor's Mastra maxSteps (default ~5 caps real turns)
  maxDepth?: number,                // default 3, harness parity
  suppressTools?: string[],         // hide noisy USER tools from the transcript
})

// Composable core — sink-shaped like pipeUIMessageStream; never settles the message:
engine.run(sink: StreamEventSink, input: string | ChatTurnMessage[], opts?: {
  abortSignal?: AbortSignal
  requestContext?: RequestContext   // entries copied into every node's context (model-tier pattern)
}): Promise<{ text: string; error?: string }>

// Settle sugar — open → run → finalize/abort, deletes empty turns, returns the settled row:
engine.respond(chat: ChatClient<C>, channelId: string, input, opts?): Promise<MessageRowOf<C> | undefined>
```

Internals (all ports, not inventions):

| piece | ported from | notes |
|---|---|---|
| registry + `delegatesTo` edge resolution + depth gate | harness `createHarness`/`#spawnChild` | unknown agent / illegal edge / depth → `{ content, isError: true }` tool result |
| `delegate` tool (`{agentType, task} → {content, isError}`) | harness `tools.ts` `makeDelegateTool` | `toolCallId` from `ctx.agent.toolCallId`; reads runtime off `requestContext` |
| runner (`agent.stream(input, { maxSteps, abortSignal, toolsets, requestContext })`) | harness runner factory | simpler than harness: the delegate tool is built per stream call closing over the turn's runtime (toolsets are per-call anyway), so no `RequestContext` runtime-key juggling; `opts.requestContext` passes through verbatim |
| lane keys + parent anchors | example `runtime.ts` | root `s:`, child `w:${toolCallId}:`, `parent` = parent lane's delegate part key; recursive for depth > 1 |
| chunk adapter | example `chunk-adapter.ts` | moved verbatim-in-structure; internal, but exported for custom loops |

**The delegate tool part is always EMITTED, never suppressed** — verification caught this as a
blocker in the draft. The harness suppresses `delegate` (`SUPPRESS = new Set([DELEGATE_TOOL])`)
because its tree anchors children by nodeId; *our* nesting anchors on the delegate **part row** —
`server.ts` `applyEvent` rejects a `part_start.parent` that doesn't name an existing tool part of
the message. Today's example already gets this right (empty suppress set; the DelegationCard is a
client-side `toolName === 'delegate'` rendering special-case). `suppressTools` therefore applies
to user tools only; `'delegate'` in it is a config error.

Also exported: **`pipeMastraStream(sink, fullStream, opts?)`** — the single-lane escape hatch
(map + drive + `end()` tail + `{ error? }` return), exact sibling of `pipeUIMessageStream`.

**Typing:** the `agent`/`subagents[].agent` params are a *structural* `MastraAgentLike`
(`{ id: string; stream(input, opts): Promise<{ fullStream: AsyncIterable<ChunkLike> }> }`), not
the nominal `Agent` class — `Agent` has an ECMAScript `#private` field, so fakes could never
satisfy it and Phase A's no-API-key tests wouldn't typecheck. Real `Agent` instances satisfy the
interface for free; one internal cast at the `agent.stream` call, exactly like harness's
`runnerFactory`. (This is also why harness unit-tests only its Mastra-free core.)

**Abort, one mechanism for everything:** `run` creates a turn-scoped internal `AbortController`
chained onto `opts.abortSignal`, and its signal is threaded into **every** `agent.stream` call at
every depth (harness parity — today's example passes nothing to the worker, so a killed turn keeps
burning tokens mid-delegation). It fires on: (a) the caller's signal, (b) a rejected
`sink.flush()` awaited at each `step-finish` chunk (the real `ChatStreamHandle` has `flush`;
plain sinks are skipped) — which catches server-side kills, disconnect-aborts, **and cap
violations** (`abortForViolation` settles the whole message; without this, sibling delegate lanes
would keep streaming into a `push()` that silently no-ops). Bounded by the client's 30s request
timeout, so no deadlock. Cost of a kill: one LLM step, not a whole tree. Docs get a sizing note:
default `maxParts` 512 / `maxEventsPerAppend` 256 vs `maxDepth` × expected tool fan-out.

### `/client` addition — `onChatMessage(chat, handler, opts)` (framework-agnostic)

Both examples hand-roll a variant of the same loop; extract it once:

```ts
const stop = onChatMessage(chat, async ({ channelId, message, history }) => {
  await engine.respond(chat, channelId, history)
}, {
  channels: 'all' | string[],  // 'all' = every channel the bot can SEE (RLS-scoped: public +
                               // already-member private), auto-joining public ones on appear —
                               // the supervisor pattern. string[] = fixed set (collections-chat).
  historyLimit?: number,       // default 8 — settled turns only; placeholders carry the error:
                               // `[error: boom — no text]` (collections-chat's richer variant)
})
```

Owns: directory watching, join-on-appear, `feed.subscribe` + seen-set dedup, skip own messages,
history assembly (`ChatTurnMessage[]`), re-watch on reconnect, teardown of a channel's store when
it leaves the visible set, and error logging per turn. Join failures are split: `CONFLICT`
(already a member) is swallowed; anything else is logged and the channel is *unmarked* so the next
directory tick retries — today's example marks-then-swallows, permanently blinding the bot to a
channel after one transient failure. Returns a detach function. (A 'membership-only, no auto-join'
mode is deliberately not offered — nothing demonstrates it; add it when something needs it.)

### `/server` addition — `provisionChatBot(authKit, chatKit, opts)`

```ts
const { user, apiKey } = await provisionChatBot(authKit, chatKit, {
  name: 'Supervisor', email?: string, metadata?: …, keyLabel: 'supervisor-runtime', channels?: string[],
})
```

Idempotent across restarts: find-or-create user (`includeDeactivated`), **revoke + re-mint the
same-label API key** via `apiKeys.listFor(userId)` filter + `revoke(id)` + `create` (today's
example mints a new key every restart and leaks them; the kit surface already suffices, no
plugin-auth change), idempotent channel joins. Revoke-then-create is not atomic — fine for a
single bot process; a rolling multi-instance restart could transiently hold two keys under one
label (documented, not solved). Structural over the two kits — no new deps.

## Resulting example wiring (the whole runtime.ts)

```ts
const { user, apiKey } = await provisionChatBot(authKit, chatKit, { name: 'Supervisor', keyLabel: 'supervisor-runtime' })
const client = createSuperLineClient(app, { transport: webSocketClientTransport({ url }), role: 'user', params: { apiKey } })
const bot = chatClient(client, { userId: user.id })
await bot.ready

const engine = mastraEngine({ agent: supervisor, subagents: [{ agent: worker }] })
onChatMessage(bot, ({ channelId, history }) => engine.respond(bot, channelId, history), { channels: 'all' })
```

~7 lines vs ~330. `agents.ts` becomes plain `new Agent(...)` (no factories); `chunk-adapter.ts` is
deleted from the example.

## Phases (TDD, one commit each)

**A — `/mastra`**: subpath + tsup entry + optional peer `@mastra/core` (devDep for tests); chunk
adapter moved in; `pipeMastraStream`; `mastraEngine` (registry, delegate tool, runner, spawnChild,
lane keys); `respond`. Tests drive **structural fake agents** (`{ id, stream: async () => ({
fullStream }) }`) — no API key, harness-self-check style: lane/parent key correctness, depth gate,
edge enforcement, unknown-agent isError, suppression (and `'delegate'` rejected in `suppressTools`),
root-error vs worker-isError propagation, tail flush, respond settle paths (finalize /
error-finalize / abort / empty-delete gated on the pushed flag), step-finish fail-fast, and
abort-mid-delegation actually cancelling the nested worker stream (the signal reaches every
depth). One loopback integration test: real server + chatClient, fake streams → parts rows land
with the parent chain, reassembled feed renders the tree after "reload".

**B — loop + provisioning**: `onChatMessage` in `/client` (extracted from both examples' loops,
both channel modes), `provisionChatBot` in `/server`. Loopback tests: join-on-appear, seen dedup,
own-message skip, history placeholders, restart idempotency + key re-mint.

**C — examples + docs**: rewrite `examples/chat-supervisor` onto the three helpers (delete its
`chunk-adapter.ts`, un-factory `agents.ts`); swap `examples/collections-chat`'s hand loop onto
`onChatMessage` (keeps `pipeUIMessageStream` — *will* prove the loop is framework-agnostic; its
canned offline fallback stays app-level in the handler); docs (`docs/how-to/plugin-chat.md`
"Hook up a Mastra agent" section, README, skill REFERENCE); browser re-verify the supervisor
example end-to-end. Two deliberate behavior changes for chat-supervisor to note in the commit:
a turn-level adapter error now settles `status:'error'` (today it throws → `abort` →
`'aborted'`), and empty turns are now deleted (today they finalize as blank).

## Decisions (all CONFIRMED 2026-07-17)

1. **Names** — `/mastra`, `mastraEngine`, `pipeMastraStream`, `onChatMessage`, `provisionChatBot`.
2. **`respond` semantics** — finalizes `{ status: 'error', error }` on a turn-level adapter error,
   and deletes empty turns gated STRICTLY on a whole-tree "was anything ever pushed" flag (a
   pushed-tracking sink wrapper, collections-chat's mechanic): never delete a turn that streamed
   something, and never delete an error/aborted settle — the user must see why a turn failed.
3. **Per-channel turn queue IS in v1** (user overrode the defer recommendation): `onChatMessage`
   serializes turns per channel — while the bot answers in a channel, newly arrived messages
   queue and are answered sequentially in arrival order (a per-channel promise chain; each
   queued turn's history then already contains the earlier answers). No coalescing, no
   cross-channel coupling: different channels still answer concurrently.
4. **Step-finish fail-fast + full abort plumbing** — included (bounds token burn when the server
   kills a stream via `chatKit.messages.abort`, a disconnect, or a cap violation — same signal
   `opts.abortSignal` rides).
