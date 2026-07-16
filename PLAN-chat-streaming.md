# PLAN — plugin-chat streaming messages

A chat message that stores an **entire agent stream** — reasoning, tool calls (nested
subagent trees included), text — accumulated live via appends, rendered richly on the
frontend, durable and late-join-correct. Motivated by super-harness: its deferred
"reload-mid-stream loses partial text" hole (PLAN-harness-plugin.md §2 model (c)) is fixed
here **in the wire layer**, as a generic primitive any producer can use (an AI SDK agent,
the collections-chat bot, a future harness bridge, an import job).

Design settled in a grill session 2026-07-16. ADR-0011 records the storage/transport call.

## Settled decisions

1. **Scope (a): generic streaming-message primitive in plugin-chat.** super-harness keeps
   its thread/node/tool tree and becomes a *consumer* later (bridge out of scope here).
   Not (b) chat-replaces-harness-collections, not (c) an edit-based mirror bridge.
2. **Content = full-fidelity, plugin-owned parts vocabulary**: `text` · `reasoning` ·
   `tool` (`toolCallId`/`toolName`/`args`/`result`, lifecycle `input-streaming → running →
   done`, `isError`). AI-SDK-`UIMessage.parts`-aligned so ai-elements renders near-verbatim.
   No `data` escape-hatch part in v1 (additive later). Errors live on the envelope, not as
   a part. The host's `content` schema keeps governing plain messages untouched; a finalized
   streamed message derives a plain-text projection into `content` so every existing reader
   (read_messages tool, notifications, search) sees a normal message.
3. **Storage = parts-as-rows.** New `chat.messageParts` collection, keyed
   `${messageId}:${idx}` (server-assigned idx). The message row is a thin envelope
   (`status`, `error?`, `lastActivityAt?`, final `content` projection). Rationale: a
   collection row update fans out the whole post-op row — one-row-holds-the-turn is
   O(turn²) on the wire; per-part rows bound every rewrite by part size and make settled
   parts free, natural checkpoints. Precedent: harness decision #6 (`harness.tools` split
   out for exactly this reason).
4. **Mutations = three `shared` requests** (ADR-0010: everything is a request):
   `startMessage` (opens envelope, `status:'streaming'`, returns id) ·
   `appendMessage` (a **batch** of stream events) · `finalizeMessage` (settles in-flight
   parts, stamps terminal status, derives `content`). Author-only, server-validated.
   The append vocabulary is a **plugin-owned union** (`part_start` / `delta` /
   `part_patch` / `part_end`) — NOT AI SDK `UIMessageChunk` verbatim; adapters absorb SDK
   drift at the edge (precedent: harness owns `HarnessEvent` instead of Mastra chunks).
5. **Delta transport = per-channel rooms + push event, shipped up front** (not deferred).
   `streamDelta` push event on the fragment, broadcast via `PluginContext.room()` —
   cluster-wide (room broadcasts ride the adapter, verified `server/src/index.ts:1200`).
   Room membership needs a `watchChannel`/`unwatchChannel` request pair (membership-
   authorized) that `chatClient.messages()` calls on open/close — nothing else tells the
   plugin a client is viewing a channel. **Topics eliminated by fact**: super-line topics
   are fixed-name role-wide feeds with no per-conn scoping → a global stream topic leaks
   private-channel deltas.
6. **Checkpoints = the correctness floor.** The in-flight part's row checkpoints ~1s with
   accumulated text + `offset`; deltas carry `(messageId, partIdx, offset, text)`. A late
   joiner / reconnecter reconstructs everything from rows alone, then splices live deltas
   by offset. Crash mid-stream leaves a readable partial message.
7. **Lifecycle = disconnect-abort, no timers.** The plugin tracks open streams per conn
   (node-local = cluster-safe; a conn lives on one node). Disconnect → auto-finalize
   `status:'aborted'`, partial content preserved, `finalizeMessage.after` fires. Hung
   process / crashed node degrade honestly: clients render `streaming` + stale
   `lastActivityAt` as interrupted; appends to settled messages → `CONFLICT`. Host escape
   hatch: `chatKit.messages.sweepStale({ olderThanMs })` (never automatic — wrong in a
   cluster). Kit-initiated streams are the host's `finally` responsibility.
8. **Hooks on `start` + `finalize` only** (`finalize.after` receives the complete
   assembled message incl. aborted — the moderation/audit point, symmetric with
   `sendMessage.after`). Appends are hook-free; the runtime kill-switch is
   `chatKit.messages.abort(messageId)` (unrestricted; wire abort stays author-only).
   Mid-stream content rewriting is producer-side by design (post-broadcast text can't be
   un-broadcast).
9. **Read side = one assembled feed.** `chat.messages(channelId)` transparently adds the
   parts subscription (one per channel) + watch enter/leave, and merges: a message object
   grows `status?` and live `parts?` (deltas spliced). Plain messages untouched (`parts`
   absent). `useMessages` and existing consumers keep working unchanged. Envelope
   `content` stays quiet until finalize (no double fan-out). Opt-out:
   `messages(id, { streaming: false })`.
10. **Subagent trees: parts carry `parent?: string`** — the `toolCallId` of the delegating
    tool part they nest under (absent = root lane; validated to reference an existing
    in-message tool part). One message = one whole turn-tree, one envelope, one feed item.
    Harness maps 1:1: a child node is spawned by a delegate toolCallId, so
    `nodeId`/`parentNodeId` collapse onto parent chains. Consequence: **in-flight parts are
    plural** (parallel subagents) — deltas/checkpoints were already keyed per part, so only
    render order changes: tree traversal (parent chains), assembled once in the plugin.
11. **Caps & cadence** (server-enforced, few knobs, `chat({ streaming: {...} })`):
    client micro-batch flush ~80ms · checkpoint ~1s · maxParts/message (roomy — a big
    turn-tree ≈ 100 parts) · maxBytes/part · maxEvents/append. Oversize →
    `SuperLineError`, stream aborts honestly.
12. **`/ai` toolset learns streamed messages**: `read_messages` renders them (final or
    partial projection + status) so agents can read each other's turns. New adapter
    `pipeUIMessageStream(writer, stream)` pipes AI SDK v6 `toUIMessageStream()` output
    into a writer.
13. **Example = the end-to-end proof.** collections-chat's bot switches from one-shot
    `generateText` to `streamText` piped through the writer — reasoning, tool calls, text
    streaming live into `#ask-ai`; the React side renders parts (tool chips, collapsible
    reasoning — ai-elements-style).
14. **Records**: ADR-0011 (parts-as-rows + ephemeral deltas + checkpoints; why topics
    lost), how-to/plugin-chat.md section, skill SKILL.md/REFERENCE.md rows. Harness
    adopting the checkpoint trick = a noted follow-up in THAT repo, not scope here.

## Schema

`messages` envelope additions (all optional — plain messages carry none):
`status?: 'streaming'|'complete'|'aborted'|'error'` · `error?: string` ·
`lastActivityAt?: number`.

`chat.messageParts` (read policy = same channel-membership filter as messages, via a
`channelId` column; write deny — server-only):
`id` (`${messageId}:${idx}`) · `messageId` · `channelId` · `idx` · `type:
'text'|'reasoning'|'tool'` · `parent?` · `text?` · `offset` (checkpointed length) ·
`toolCallId?` · `toolName?` · `args?` · `result?` · `isError?` ·
`state?: 'input-streaming'|'running'|'done'` · `done: boolean`.

Append event union (wire; producer references parts by a producer-side key — the
`toolCallId` for tool parts, a writer-generated key otherwise; the server maps key→idx):
`part_start { key, type, toolName?, parent? }` · `delta { key, text }` ·
`part_patch { key, args?, result?, isError?, state? }` · `part_end { key, text? }`.

`streamDelta` push event: `{ channelId, messageId, partIdx, offset, text }`.

## Phases (TDD, review workflow per phase — sonnet finders / haiku verifiers)

**Phase 1 — contract + server core.** Fragment: parts collection, envelope fields, 3
requests + watch pair + `streamDelta` event. Server: domain cores (start/append/finalize/
abort) with hooks wired, per-message append serialization, part-key→idx mapping, room
broadcast, checkpoint scheduler, disconnect-abort tracking, caps, RLS for parts,
`chatKit.messages.{stream,abort,sweepStale}`. Tests: happy path over loopback; late-join
mid-stream reconstructs from checkpoints then splices; offset dedup across
checkpoint+delta overlap; abort-on-disconnect preserves partials + fires finalize.after;
author-only enforcement; non-member watch → FORBIDDEN + parts RLS; plural in-flight parts
(parallel subagent lanes); `parent` validation; caps; hooks fire for both initiators;
CONFLICT on append-after-settle.

**Phase 2 — client + react.** `chat.stream(channelId)` writer (micro-batch, finalize/
abort, guaranteed flush ordering), assembled feed in `messages()` (parts merge + delta
splice + tree order + rekey on channel-set change), `{ streaming: false }` opt-out,
react passthrough (no API change — `useMessages` rows gain `parts?`/`status?`). Tests:
client integration incl. reconnect mid-stream, concurrent streams in one channel,
tree-ordered assembly.

**Phase 3 — /ai + example + docs.** `pipeUIMessageStream` (text/reasoning/tool chunk
mapping), `read_messages` streamed rendering; collections-chat bot streams via
`streamText` + writer, React parts renderer; ADR-0011, how-to section, skill rows,
package READMEs. Verified live end-to-end (agent streams a tool-using turn into #ask-ai).

**Phase 4 — supervisor/subagent example (`examples/chat-supervisor`).** Replicates the
*behavior* of super-harness's `examples/web` — a Mastra supervisor delegating to a worker
with a live weather tool, the whole nested turn streaming into one message — WITHOUT
super-harness. This is the proof that decision 10 (`parent` trees) is sufficient for the
harness flagship UI on plugin-chat alone:
- Server: plugin-auth + plugin-chat, seeded channel + provisioned bot (the collections-chat
  recipe). Two Mastra `Agent`s (supervisor + worker; Mastra is an **example-local** dep —
  plugin-chat's dependency surface is untouched). A hand-rolled `delegate` tool on the
  supervisor: on call, run `worker.stream(task)` and pipe its chunks into the SAME
  streaming message with `parent = the delegate toolCallId` — the example owns a small
  Mastra-chunk→writer mapper (the harness `chunk-adapter` pattern, simplified: remember
  which toolCallIds are delegates). Worker keeps the real Open-Meteo weather tool so
  error→retry→completed tool states occur naturally.
- Client: minimal Vite/React chat on the plugin hooks; renders the turn-tree — supervisor
  text, delegate block with the worker's own tool chips + text nested inside (per-tool
  status badges), supervisor summary after. Concurrent delegates exercise plural in-flight
  parts visually.
- Explicitly OUT of scope: harness cockpit features (modes/model tiers, approvals,
  attachments, thread sidebar, node selectbox) — this phase demonstrates the streaming
  primitive, not a harness replacement.
- Docs tail: README for the example + a "supervisor trees" subsection in the how-to
  linking it; note in super-harness follow-ups that its bridge can reuse this mapper.
