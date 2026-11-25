# ADR-0030: Clients may exchange data directly; the server brokers admission and signaling and stays out of the data path

- Status: Accepted
- Date: 2026-11-25 — designed and built in the plugin-peer effort (tickets 1–6, the same day)
- Plan: `docs/plans/PLAN-plugin-peer.md`
- Builds on: [ADR-0005](0005-plugins-as-paired-runtime-bundles.md) and
  [ADR-0019](0019-plugins-grow-a-contract-time-half.md) (a paired plugin with a contract fragment),
  [ADR-0021](0021-column-layout-is-derived-from-standard-json-schema.md) (user schemas are Standard Schema;
  core imports no schema library), [ADR-0027](0027-a-connection-is-reconstructible-from-its-snapshot.md)
  (room membership survives a hibernation wake, so a stateless server needs no recovery),
  [ADR-0028](0028-liveness-belongs-to-the-transport.md) (no server timers)
- Qualifies: the server-authoritative tenets ("nothing on the wire is trusted", "the server owns rooms")
  for payloads on a peer channel only; [ADR-0004](0004-composition-over-connection-namespaces.md) (one
  socket, one identity: a peer link is a second data path outside it); [ADR-0024](0024-the-client-observes-itself-and-emits-frames.md)
  (the client tap sees signaling, never peer traffic)

## Context

The driving use case is phones in a browser acting as game controllers for a game in a desktop browser
shown on a TV. Stick input is sent every animation frame, and every millisecond of the round trip is felt.
Through the server it is phone → server → screen: two hops, a head-of-line-blocked TCP stream, and a
server that must accept, validate and fan out sixty messages a second per player only to forward them.

Every other super-line pattern goes through the server, which is the point of the design: it validates
every inbound message against the contract and decides who receives what. WebRTC data channels give a
direct, optionally unreliable path between two browsers, but they need signaling (an SDP offer and answer
and ICE candidates carried by some other channel) and a way to decide who may connect to whom. super-line
already has an authenticated, server-authoritative connection on every client, which is exactly the
signaling channel WebRTC lacks.

Constraints that shaped the design: no change to core, server or client; no server-side plugin state (so
a Durable Object wake needs no recovery and a cluster needs no shared store); no server timers and no
`ctx.hold()`; rooms are the only pairing API.

## Decision

**Clients may exchange data directly over WebRTC data channels. The server authorizes and brokers
admission and relays signaling, and is never in the data path.** `@super-line/plugin-peer` ships it as a
paired plugin: `peerContract({ channels })` (the contract fragment, with the user's channels as Standard
Schemas), `peer({ authorizeCreate, authorize })` (the server half), and `peerClient(client, fragment,
opts)` (the client half, a function over a `SuperLineClient` like `chatClient`, not a client plugin).

### Authority comes from the room secret, not from server-room membership

The creator generates a 128-bit `ownerSecret` on the client. The room key is `SHA-256(ownerSecret)`, and
the server room that receives join requests is named after `SHA-256(roomKey)`. Every owner operation
(`peerCreateRoom`, `peerAdmit`, `peerRemove`, `peerCloseRoom`) carries the secret, and the server
recomputes the key from it. The server stores nothing.

Server-room membership could not be the authority. Hosts commonly let clients join rooms by name: it is
the canonical pattern in this repo's tutorial, skill and examples, with an unconstrained `room` string.
On such a host, anyone holding the key could compute the owner room's name, join it, receive every join
request and pass an "is a member of the owner room" check. With the secret as authority, joining that
room grants nothing but a copy of the (hashed, ticketed) join requests.

### The key is derived from a client-generated secret, so it survives a reconnect

A dropped socket comes back under a new connection id (only resuming transports keep it). Because the key
depends only on the secret the creator holds in memory, the creator re-sends `peerCreateRoom` with the same
secret after a reconnect and re-claims the same key. The QR code on the TV stays valid through a Wi-Fi
blip.

### Admission is the creator's decision, carried by requests and events

`peerJoin` runs the host's `authorize` (deny by default; `{ info }` attaches a host-chosen, server-attested
descriptor) and broadcasts a join request, stamped with the joiner's server-verified id and role, into the
owner room. The creator's `accept` decides; its `peerAdmit` makes the server emit `peer.admitted` to the
joiner and `peer.joined` to each existing member. The server does not know whether anyone owns a room, so
an unowned key times out on the client. A joiner sends a random ticket with its join; a returning ticket is
admitted without `accept` and replaces the member that held it, which is how a joiner re-joins after its
connection id changed.

### Full mesh, receiver-side validation

Every member links to every other member (one `RTCPeerConnection` per pair, MDN perfect negotiation,
pre-negotiated data channels: id 0 is an internal control channel, user channels get ids in sorted-name
order). A room is capped at 33 members, so the wire's 32-member lists hold. The first control message is a
hello naming both ends and the room; a link whose hello does not match the server-stamped peer is closed,
which stops an admitted member from relaying someone else's SDP under its own identity.

The **receiving** client checks each message's size against the channel's `maxBytes`, decodes it, and
validates it synchronously against the channel schema before any handler sees it. The sender's check is
the type system only.

### Signals and membership events are buffered, because order is not guaranteed

`peer.admitted`, `peer.joined` and `peer.signal` are separate emits, possibly from different nodes, so a
newcomer can receive an existing member's offer before its own admission, and an earlier joiner can hear of
a later one before it was admitted itself. Perfect negotiation never re-sends a dropped offer. So the client
holds signals and `peer.joined` frames from senders that are not yet members while a join is pending or a
room is held, and replays them in arrival order when the sender becomes a member. The buffer is bounded per
sender, per key and in bytes (a full room's worth of real signaling with room to spare, about 350 KB of
512 KB), and expires with the join timeout.

### Only the impolite side makes the first offer

Perfect negotiation lets both sides offer and has the polite side roll back on a collision. In Chrome, a
polite side that rolled back its own first offer and then answered left the link unconnected: 5 of 7 such
trials stayed `connecting` until the connect timeout, some with no local candidate gathered after the
rollback, while 9 of 9 trials without a rollback connected. The polite side therefore skips
`negotiationneeded` until it has applied a remote description, so a browser pair never collides on its
first offer. Perfect negotiation stays in place for every later negotiation. libdatachannel, which sets a
local offer on its own as soon as a channel is created, still collides and rolls back implicitly, which it
handles.

### Liveness and reconnect are the clients'

Link liveness is a control ping after 1 s without sending and a 3 s silence timeout, on the link itself: no
server timer. A joiner whose server connection reconnects, or whose link to the creator closes, re-joins
with its ticket, backing off, and gives up after a bounded number of attempts. The creator re-claims its
keys on reconnect. A creator that leaves sends `end` on its links, and joiners close at once.

### No relay fallback

A pair that cannot connect directly reports link state `failed`. The host supplies STUN and TURN through
`iceServers` (an array or a function called per peer connection, for short-lived TURN credentials). A
relay through the super-line server would put the server back in the data path the plugin exists to leave.

## What this costs the server-authoritative model

This is a deliberate, opt-in exception, scoped to payloads on a peer channel:

- **The server never sees, validates, stores or revokes peer payloads.** "Nothing on the wire is trusted"
  still holds, but the party that refuses untrusted input is the receiving client, not the server. A
  modified client can send anything that fits a channel's `maxBytes`; only the receiver's schema stands
  between it and the receiver's handlers.
- **The server does not own the room's membership.** It authorizes creation and join requests and stamps
  identity on everything it relays, but the member list lives in the clients. Kick and membership are
  enforced by honest clients: the creator and the other members drop a kicked member, and an open link
  survives the server disconnecting or revoking either end.
- **Members are visible to each other.** They learn each other's connection ids (the session id under
  plugin-auth) and, through ICE, IP addresses. `iceTransportPolicy: 'relay'` hides addresses at TURN cost.
- **Secrets cross the server.** The owner secret, room keys, tickets, SDP and candidates are request and
  event payloads, so the inspector shows them unless the host redacts them. A ticket on its own grants a
  seat.
- **Observability stops at signaling.** Peer messages bypass the client's `sendFrame()` and the client tap,
  so the DevTools panel and the Control Center see the plugin's requests and events, never channel traffic.
  A `peer` tap kind would need a core change and is deferred.
- **Both peers must reach the same node or cluster** (on Cloudflare, the same Durable Object name), since
  signaling goes through `toConn`.

Everything else is unchanged: who may create and who may ask to join are server decisions, deny by default,
and every signaling request is validated against the fragment's strict, bounded schemas.

## Considered and rejected

- **The creator's connection id embedded in the key** (`<connId>.<random>`), so a join could be routed with
  `toConn` and the creator checked by id. A reconnect changes the creator's id, so one Wi-Fi blip would
  make the key, and the QR code, dead for good; later joiners could never be admitted.
- **Server rooms for members**, with the server checking room membership before relaying a signal or
  accepting an admit. Hosts that let clients join rooms by name make membership forgeable (see above);
  and room names also show in the inspector, presence descriptors, Redis and Durable Object snapshots, so
  an attacker would not even need the key. Departures come from the links themselves (`bye`, liveness)
  instead.
- **Exposing `request` on the plugin's `toConn`**, so `peerJoin` could await the creator's answer with a
  server→client request. It needs a server change, holds a pending request with a server-side timeout on
  the joiner's node (a timer, which keeps a Durable Object awake), and the default request timeout is
  shorter than a person may take to decide. The creator answering with its own `peerAdmit` request keeps
  the server stateless.
- **A relay fallback through the server.** See above. It would also have covered smart-TV web runtimes
  that block WebRTC, but only by undoing the decision; those runtimes are out of scope instead.
- **A polite rollback of the first offer** (textbook perfect negotiation on the first exchange). Measured
  to leave about a third of links unconnected in Chrome.

## Consequences

- A room is a full mesh: `n − 1` peer connections per member even when the app talks to one of them.
  Fine at the use case's size (a screen and up to 32 controllers); a star topology would be a later option.
- The creator must hold `crypto.subtle` to derive the key, so `createRoom` needs a secure context
  (HTTPS or `localhost`); `join` does not.
- A plugin-auth session replacement builds a new `SuperLineClient`; the app builds a new `peerClient`.
  Documented, not automated.
- A link to the creator that fails before it ever opened does not start a re-join; the next
  `visibilitychange` to `visible` does, or the app retries. Phones should hold a Screen Wake Lock.
- Verified with node-datachannel (automated, including a Node process exiting cleanly after `leave()`) and
  desktop Chrome (by hand). Real phones, TURN, Firefox and Safari are untested.
