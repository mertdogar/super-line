# ADR-0028: Liveness belongs to the transport, not a server timer

- Status: Accepted
- Date: 2026-10-14 — settled in the cloudflare-workers wayfinder effort (T05 lock)
- Plan: `docs/plans/PLAN-cloudflare.md`

## Context

The server runs one `setInterval` that pings every connection, counts missed pongs, and reaps dead sockets.
A Durable Object never hibernates while a timer is scheduled, so this one timer would keep every super-line
node on Cloudflare awake forever and silently defeat the entire hibernation design. Moving the ping onto a DO
alarm would wake the object every interval, which is the same thing with extra steps.

The platform already answers protocol pings without waking the object, and `setWebSocketAutoResponse` answers
one exact text message the same way. Meanwhile the client has no liveness of its own today: it only answers
server pings, so a dead socket is noticed by the OS or never.

## Decision

**A transport may declare it owns liveness (`liveness: 'socket'`); when every started transport does, the
server starts no heartbeat timer.** The Cloudflare transport declares it and installs an auto-response for
the JSON `{"t":"ping"}` → `{"t":"pong"}` pair, and the client gains an opt-in `keepalive` that sends that ping
and closes the socket when the pong is late. The server also answers an inbound `ping` on every transport, so
the client option is not Cloudflare-specific.

Consequences:

- On a hibernating node `onHeartbeat` never fires and plugin-auth's `lastSeenAt` means "last wake". This is
  documented rather than worked around; the alternative is a node that never sleeps.
- Reaping moves from the server (missed pongs) to the socket and the client (late pong); a Node server with
  the WebSocket transport keeps its timer and behaves exactly as before.
- The auto-response pair is only installed for the default JSON serializer, because it matches exact text.
  A custom serializer still works; its keepalive pings wake the object.
