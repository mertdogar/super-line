# Drive a channel from scripts

A chat channel can be driven with **no UI at all**: a line protocol over stdin/stdout that a shell
script, a CI job, or **another agent** can speak. Send a bare line, get the bot's streamed reply as
greppable markers — or as **pure JSONL** where one `jq` parses everything. The
[chat-supervisor example](/examples/chat-supervisor-tui) ships a complete implementation
(`src/tui/headless.ts`); this guide documents its protocol and the pattern to copy into your own
app.

The shell is the same binary as the terminal cockpit — headless is **auto-selected when stdout is
not a TTY** (piping is enough), or forced with `--headless`:

```bash
cd examples/chat-supervisor
pnpm tui --channel agents | tee chat.log            # human mode (piped ⇒ headless)
pnpm tui --headless --channel agents --json          # machine mode: pure JSONL
```

Auth never prompts: it reuses the session file the cockpit's login wrote
(`~/.chat-supervisor-tui.json`), or `--token` / `CHAT_SUPERVISOR_TOKEN`. Neither present → a clear
error telling you to run the cockpit once.

## Human mode — markers for lifecycle, lines for content

Markers mark **state transitions only**; everything else is a plain line. Messages print as
`#channel author: text` (streaming deltas coalesced into the settled line), resource cards as a
`⧉` line:

```
<<READY user=mert channel=agents>>
#agents you: add a sticky note for each launch task
<<TURN_START channel=agents msg=1d20083d-…>>
#agents Supervisor: Done — four notes on the board.
⧉ canvas “Canvas” created by Supervisor
<<TURN_DONE channel=agents msg=1d20083d-…>>
<<RESUME bun src/tui/index.tsx --headless --channel agents>>
```

The full marker set: `READY`, `TURN_START` / `TURN_DONE` (a bot message's `status` entering /
leaving `streaming` — the thing scripts most often wait on), `ERROR`, `DISCONNECTED` /
`RECONNECTED`, and `RESUME` (the exact re-invocation, printed on clean exit). Oversized payloads
spill to `--spill-dir` files with an inline `[+N chars -> path]` pointer instead of flooding the
stream.

## `--json` — pure JSONL, a curated vocabulary

In `--json` **every** stdout line is JSON — lifecycle becomes `{type:"status"}` events, no ASCII
markers — with a small, stable vocabulary decoupled from wire internals:

| `type` | When |
| --- | --- |
| `status` | `kind: ready · turn_start · turn_done · disconnected · reconnected · resume` |
| `message` | a message settled (user echo, or a bot turn completing, with `content` + `status`) |
| `delta` | progressive text for a streaming part |
| `part` | a tool/delegation part appeared or changed state (`toolName`, `parent`, `done`) |
| `resource` | a resource card landed (`kind`, `docId`, `action: created · attached · detached`) |
| `error` | a turn errored |
| `info` | the reply to a REPL command (`/who`, `/channels`, …) |

The two recipes that matter for a driver:

```bash
# watch the bot type
pnpm tui --headless --channel agents --json | jq -cr 'select(.type=="delta").text'
# block until the turn is done (the turn gate)
pnpm tui --headless --channel agents --json | jq -c 'select(.kind=="turn_done")' | head -1
```

## Input — current channel + commands

A bare stdin line **sends to the current channel** (`--channel` at boot, `/channel <name>` to
switch). Commands: `/channels`, `/channel <name>`, `/new <name>`, `/who`, `/session`, `/help`,
`/quit`. For a long-lived session driven out-of-band, `--control <path>` creates a FIFO and
reopens it in a loop, so repeated one-shot writes from any shell just work:

```bash
pnpm tui --headless --channel agents --control /tmp/ctl.fifo &
echo 'summarize the canvas' > /tmp/ctl.fifo
echo '/channel launch-plan'  > /tmp/ctl.fifo
```

## The pattern, if you're building your own

The implementation is ~4 small modules over the **framework-agnostic clients** (`chatClient` +
plugin-auth's `authClient` — no React): subscribe `messages(channelId)` and **diff successive
snapshots into events** (a `FeedDiffer` per channel). Turn markers fall out of `FeedMessage.status`
transitions; deltas fall out of suffix-diffing each part's `text` between snapshots (the feed
already coalesces wire deltas onto `part.text`, so the suffix *is* the coalesced delta); prime the
initial backlog as already-seen so history isn't replayed on join. Keep the UI renderer's imports
dynamic so none of it loads in the headless path.

Two honest v1 gaps: no `presence` events (presence is doc-scoped — it needs docs held open, which
is the cockpit pane's job, not the feed's), and `resource` events cover **cards** only — live CRDT
content edits don't flow through the message feed.

This guide assumes the chat plugin is wired — see [the chat backbone](/how-to/plugin-chat), then
[streamed messages](/how-to/chat-streaming) for the part model the JSONL events mirror.
