# ADR-0027: A connection is reconstructible from its snapshot

- Status: Accepted
- Date: 2026-10-14 — settled in the cloudflare-workers wayfinder effort (T04 prototype, T05 lock)
- Plan: `docs/plans/PLAN-cloudflare.md`

## Context

A Durable Object hibernates after about ten idle seconds: its sockets stay open, but the server instance is
discarded and rebuilt on the next event. Every per-connection registry the server holds — channels, row
subscription filters, open CRDT docs, reserved-connection bridges — is gone, while the client on the other
end of the socket still believes it is subscribed. The obvious fix, closing every socket on wake so clients
reconnect, was rejected: it turns every idle period into a visible disconnect.

Serialising the server's registries was the first idea and the wrong one: they are derived state. The
prototype showed that the only inputs are the authenticate outcome and the subscribe frames the client sent
(`sub`, `csub`, `cdopen`), plus rooms, which host handlers join and no frame reproduces. Replaying those
frames through the ordinary handlers on a fresh instance, with their acknowledgements muted, rebuilt every
registry and the client saw nothing — no disconnect, no reconnect, live delivery resumed.

## Decision

**A connection's server-side state is reconstructible from a `ConnectionSnapshot` = the authenticate outcome
(with a mandatory `connectionId`), `connectedAt`, the rooms joined, the live subscribe frames net of their
unsubscribes, and optional per-plugin blobs.** The server keeps it current at frame ingress and pushes it to
the transport synchronously on every change; a transport that wants it persists it, and on wake hands it
back through `adoptConnection(raw, snapshot)`, which is the normal accept path plus room re-adds plus a muted
replay. Snapshots live wherever the transport chooses; on Cloudflare that is DO SQLite keyed by connection
id, because the socket attachment limit (16 KiB) is below a realistic subscription-heavy snapshot.

Consequences the code must honour:

- A subscribe is recorded only when it succeeded; a replay that is now refused (policy changed, collection
  gone) is reported to the client with a new `end` frame rather than swallowed. `end` is a general server
  capability — it is the first way to end one subscription without dropping the connection.
- `conn.data` is not part of the snapshot (untyped host scratch); `onConnection` reruns on adopt and may
  re-seed it. `conn.env` is in the snapshot: "never persisted" on its doc-comment meant the cluster presence
  directory, not server-private storage.
- A hibernated single-node object cannot have changed, so adopt never re-snapshots rows or docs. A
  multi-node design could not rely on this; it is one reason clustering across objects is out of scope.
- Per-connection plugin state must be either frame-derived, contributed through
  `snapshotConnection`/`restoreConnection`, or kept alive with the busy token (`PluginContext.hold()`), which
  is what plugin-chat does for an open stream.

## Considered and rejected

- **Forced reconnect on wake.** Simple, but every idle period becomes a client-visible disconnect; kept only
  as the fallback for a socket whose snapshot row is missing.
- **Serialising the registries.** Couples the snapshot format to every internal map, and misses nothing the
  frames don't already carry.
- **Attachment-only storage.** 16 KiB; a dashboard-sized connection is already at the limit.
