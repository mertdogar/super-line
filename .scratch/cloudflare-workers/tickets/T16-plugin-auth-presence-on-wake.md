---
id: T16
title: plugin-auth sessions and presence survive a wake
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [T12]
---

## Question

On a hibernating node, plugin-auth's `sessions` / `userPresence` stop describing who is connected. Make them correct on `transport-cloudflare` (or decide, with the user, that they are documented as unsupported there), then update the T12 docs that currently state the limitation.

Found at T12 by reading the code (not yet reproduced in a test):

1. **Every wake ends every live session.** `setup` (`packages/plugin-auth/src/server.ts` ~466–472) closes all `endedAt === null` sessions whose `nodeKey` matches, as crash recovery. `createDurableNode` passes `nodeKey = ctx.id` (stable) and the constructor — so `setup` — runs on every wake, while the sockets those sessions belong to are adopted and live. `refreshPresence` then marks their users offline. Adoption never calls `authenticate`, so nothing re-opens them. Real disconnects later call `endSession` on an already-ended row.
2. **`lastSeenAt` never advances.** It is refreshed only by `onHeartbeat`, which a `liveness: 'socket'` transport turns off. `USER_PRESENCE_LIVE_MS` (~90 s) expires every user 90 s after connecting even with (1) fixed. T11's example showed no online state, attributed to this.

Shape of a fix to weigh (not decided): reconcile only sessions with no adopted connection (needs ordering against `resume()`, which runs after `setup`), or re-open a session when its connection is adopted (the server re-runs `onConnection` on adopt — a plugin-side equivalent?); for (2), refresh `lastSeenAt` on wake / on inbound frames, or a presence model that doesn't need a heartbeat. Prove it in the workers lane with `evictDurableObject` (sessions + `userPresence` before and after a wake). plugin-auth changes source → it joins T13's release wave.

T12 docs that state the current limitation and must change with the fix: `docs/how-to/cloudflare-durable-objects.md` (§ Presence on a hibernating node + Plugins bullet), `docs/how-to/auth-sessions-roles-keys.md` (warning under User presence), `docs/how-to/plugin-chat.md` (presence paragraph), skills `REFERENCE.md` (Cloudflare prose) + `SKILL.md` + `AGENTS.md` (Cloudflare gotcha bullet).
