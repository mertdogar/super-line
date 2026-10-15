---
id: T16
title: plugin-auth sessions and presence survive a wake
labels: [wayfinder:task]
status: closed
assignee: session_01CAGnLSs3WJLSaww41tSX5T (2026-10-15)
blocked-by: [T12]
---

## Question

On a hibernating node, plugin-auth's `sessions` / `userPresence` stop describing who is connected. Make them correct on `transport-cloudflare` (or decide, with the user, that they are documented as unsupported there), then update the T12 docs that currently state the limitation.

Found at T12 by reading the code (not yet reproduced in a test):

1. **Every wake ends every live session.** `setup` (`packages/plugin-auth/src/server.ts` ~466–472) closes all `endedAt === null` sessions whose `nodeKey` matches, as crash recovery. `createDurableNode` passes `nodeKey = ctx.id` (stable) and the constructor — so `setup` — runs on every wake, while the sockets those sessions belong to are adopted and live. `refreshPresence` then marks their users offline. Adoption never calls `authenticate`, so nothing re-opens them. Real disconnects later call `endSession` on an already-ended row.
2. **`lastSeenAt` never advances.** It is refreshed only by `onHeartbeat`, which a `liveness: 'socket'` transport turns off. `USER_PRESENCE_LIVE_MS` (~90 s) expires every user 90 s after connecting even with (1) fixed. T11's example showed no online state, attributed to this.

Shape of a fix to weigh (not decided): reconcile only sessions with no adopted connection (needs ordering against `resume()`, which runs after `setup`), or re-open a session when its connection is adopted (the server re-runs `onConnection` on adopt — a plugin-side equivalent?); for (2), refresh `lastSeenAt` on wake / on inbound frames, or a presence model that doesn't need a heartbeat. Prove it in the workers lane with `evictDurableObject` (sessions + `userPresence` before and after a wake). plugin-auth changes source → it joins T13's release wave.

T12 docs that state the current limitation and must change with the fix: `docs/how-to/cloudflare-durable-objects.md` (§ Presence on a hibernating node + Plugins bullet), `docs/how-to/auth-sessions-roles-keys.md` (warning under User presence), `docs/how-to/plugin-chat.md` (presence paragraph), skills `REFERENCE.md` (Cloudflare prose) + `SKILL.md` + `AGENTS.md` (Cloudflare gotcha bullet).

## Decisions (2026-10-15, with the user)

- **Sessions:** reconcile *after adoption*. The Cloudflare transport adopts surviving sockets inside `start()`, so `server.ready` means "surviving connections are back"; `PluginContext.ready` exposes it; plugin-auth's boot sweep awaits it and ends only sessions with no live connection. Zero writes per wake. Public `resume()` goes away (unpublished).
- **Presence:** opt-in "trust the socket" — `chatClient({ presenceTimeoutMs: Infinity })` reads an open session as online; docs tell Cloudflare hosts to set it. `endSession` stamps `lastSeenAt` with the close time when no pong was ever seen. Caveat documented: a vanished client reads online until the platform closes its socket (timing undocumented).

## Resolution

**BUILT** (2026-10-15). Reproduced bug 1 first: a workers-lane test showed a wake ending the live session (`endedAt` stamped 13 ms after the evict).

- `transport-cloudflare` resumes surviving sockets from the promise `start()` returns, so `srv.ready` means "every surviving socket is back"; public `resume()` removed; `createDurableNode` = `blockConcurrencyWhile(() => server.ready)`.
- `server`: `PluginContext.ready` (= `srv.ready`).
- `plugin-auth`: boot sweep awaits `ctx.ready` and spares sessions whose id is a live connection; `endSession` stamps `lastSeenAt = max(row, lastPongAt ?? now)`.
- `plugin-chat`: `presenceTimeoutMs: Infinity` accepted (open session = online, no expiry timer); `0`/negative/`NaN` still throw.
- Tests: `test-workers/auth-presence.workers.test.ts` (new `AuthNode` DO, migration v5) — session + `userPresence` unchanged across a real eviction, a later close ends it with the close time, and a socket that didn't survive (4409) has its session ended by the sweep. Two chat-client unit tests. Fast 857/857, workers 71/71, typecheck + lint clean, `docs:build` green.
- Docs: cloudflare how-to (presence section rewritten, plugin-auth bullet, hand-written class, "seed" bullet no longer claims the seed runs before the resume), auth-sessions tip, plugin-chat presence paragraph, transport-cloudflare README, all four skills, PLAN-cloudflare "As built (T16)".
- Still unverified (needs a real deploy): how long Cloudflare takes to report a vanished client's socket closed — documented as undocumented.
- Release notes for T13 appended there.
