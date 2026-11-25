# PLAN: `@super-line/plugin-peer` — direct client-to-client rooms

Status: in progress. Decision record: ADR-0030 (written with the docs ticket).

## Goal

Two or more super-line **clients** exchange data directly over WebRTC data channels. The super-line
server brokers the connection (admission and signaling) and then carries none of the data.

Driving use case: phones in a browser act as game controllers for a game running in a desktop browser
shown on a TV. Latency matters. Payloads are mostly JSON.

Target runtimes: full desktop and phone browsers. Smart-TV web runtimes are out of scope (most block
WebRTC for third-party apps). There is **no relay fallback** through the server: a pair that cannot
connect directly reports link state `failed`, and the host supplies STUN/TURN through `iceServers`.

## Constraints

- **No change to `@super-line/core`, `@super-line/server` or `@super-line/client`.** If a ticket finds
  one is truly required, stop and report it instead of making it.
- The server keeps **no plugin state in memory** (so a Durable Object hibernation wake needs no
  recovery, and a cluster needs no shared store). The only server-side footprint is one server room per
  peer room.
- No server-side timers and no `ctx.hold()`.
- Rooms are the only pairing API. There is no `address()` / `connect()`.

## Package

`packages/plugin-peer`, subpaths (same packaging pattern as `plugin-chat` / `plugin-auth`):

| Subpath | Exports |
| --- | --- |
| `.` | `peerContract({ channels })`, shared types |
| `/server` | `peer({ authorize, authorizeCreate, maxRoomsPerConn? })` → `{ plugin }` |
| `/client` | `peerClient(client, contract, opts)` |

No React half in v1. `zod ^4.2.0` is a regular dependency for the plugin's own wire surface. User
channel schemas are **Standard Schema** (reuse core's types and its synchronous validation helper; async
validators are rejected, as in plugin-chat's `hostSchema`).

## Public surface

```ts
// shared
export const peerFragment = peerContract({
  channels: {
    input:  { schema: Input, reliable: false },   // unordered, maxRetransmits: 0
    events: { schema: GameEvent },                // reliable + ordered (default)
  },
})
defineContract({ plugins: [peerFragment], ... })

// server
const peerKit = peer({
  authorizeCreate: ({ creator, ctx }) => true,                 // required; omitted ⇒ every create denied
  authorize: ({ joiner, roomKey, ctx }) => ({ info: { name } }) // required; false | true | { info }
})
createSuperLineServer({ plugins: [peerKit.plugin], ... })

// client
const p = peerClient(client, peerFragment, { iceServers, serializer?, rtc?, onError?, document?, ... })

const room = await p.createRoom({ accept: (joiner) => true, maxMembers: 8 })
room.key                                  // long random string → QR code / link
const room = await p.join(key)            // resolves on admission

room.self                                 // { id, role }
room.members                              // [{ id, role?, info?, link: 'connecting' | 'open' | 'failed' }]
room.state                                // 'active' | 'rejoining' | 'closed'
room.onState((state) => ...)
room.onMember((event) => ...)             // joined | left | link-state change
room.channel('input').send(msg)           // every member whose link is open
room.channel('input').to(memberId).send(msg)
room.channel('input').on((msg, from) => ...)   // returns an unsubscribe
room.kick(memberId)                       // creator only
room.leave()
room.onClose((reason) => ...)             // 'left' | 'kicked' | 'closed' | 'refused' | 'lost'
p.close()
```

Channel names and message types are inferred from the `channels` argument (const generics, as
`defineContractPlugin` does). Channels are symmetric: both ends send and receive the same schema.

`iceServers` is `RTCIceServer[]` or `() => Awaitable<RTCIceServer[]>` (called per peer connection, so a
host can vend short-lived TURN credentials). `iceTransportPolicy` passes through. `rtc` injects the
`RTCPeerConnection` constructor (default `globalThis.RTCPeerConnection`) — tests and Node hosts pass
`node-datachannel`'s polyfill.

## Wire surface (contract fragment, `shared` block)

Requests are camelCase, events dot-prefixed, following plugin-chat. Every schema is strict and bounded.

| Request | Input | Output |
| --- | --- | --- |
| `peerCreateRoom` | `{ ownerSecret }` | `{ roomKey, self: { connId, role } }` |
| `peerCloseRoom` | `{ ownerSecret }` | `{}` |
| `peerJoin` | `{ roomKey, ticket }` | `{ self: { connId, role } }` |
| `peerAdmit` | `{ ownerSecret, joiner: { connId, info? }, accept, members: [{ connId, info? }] }` | `{}` |
| `peerRemove` | `{ ownerSecret, member, members: connId[] }` | `{}` |
| `peerSignal` | `{ roomKey, to, kind: 'offer' \| 'answer' \| 'candidate', sdp? , candidate? }` | `{}` |

| Event | Payload | Emitted |
| --- | --- | --- |
| `peer.joinRequest` | `{ keyHash, ticket, joiner: { connId, role, info? } }` | broadcast to the owner room |
| `peer.admitted` | `{ roomKey, accept, by: { connId, role }, members: [{ connId, info? }] }` | `toConn(joiner)` |
| `peer.joined` | `{ roomKey, member: { connId, info? } }` | `toConn(each listed member)` |
| `peer.left` | `{ roomKey, member }` | `toConn(each listed member + the removed one)` |
| `peer.signal` | `{ roomKey, from: { connId, role }, kind, sdp?, candidate? }` | `toConn(to)` |

Bounds: `ownerSecret`, `roomKey`, `ticket` exact-length base64url (128 bits of entropy → 22 chars for
the secret and ticket, 43 for the SHA-256 key); `connId` ≤ 128 chars; `members` ≤ 32; `sdp` ≤ 64 KB;
`candidate` is the browser's ICE candidate object (`candidate` string ≤ 2 KB plus optional `sdpMid`,
`sdpMLineIndex`, `usernameFragment`; an empty string means end-of-candidates). `peerSignal` is split by
`kind`: `offer`/`answer` must carry `sdp`, `candidate` must carry `candidate`. `info` is a flat, bounded
map of scalars. The field is named `roomKey` (not `key`) so hosts can redact it in the inspector
without hiding every `key` in the feed.

## Server half

All hashing is `await globalThis.crypto.subtle.digest('SHA-256', …)` (works in Node and workerd; do not
import `node:crypto`).

- `roomKey = base64url(SHA-256(ownerSecret))`, `keyHash = base64url(SHA-256(roomKey))`,
  owner room name = `'peer-owner:' + keyHash`.
- **`peerCreateRoom`**: run `authorizeCreate({ creator: ctx.describe(conn), ctx })`; deny ⇒ `FORBIDDEN`.
  Reject when the connection already owns `maxRoomsPerConn` (default 8) rooms, counted from
  `ctx.describe(conn).rooms` entries with the `peer-owner:` prefix (no new state). `await
  ctx.room(ownerRoom).add(conn)`; if the socket closed meanwhile (`!conn.raw.writable`), remove it again.
  Return `{ roomKey, self }`. Sending the same secret again re-claims the same key (idempotent).
- **`peerCloseRoom`**: recompute the owner room from the secret and remove the calling connection from
  it. Stateless: it frees the `maxRoomsPerConn` slot, and join requests stop reaching that connection.
  The creator's `leave()` and `p.close()` send it.
- **`peerJoin`**: run `authorize({ joiner: ctx.describe(conn), roomKey, ctx })`. `false` ⇒ `FORBIDDEN`.
  `true` or `{ info }` ⇒ `ctx.room(ownerRoom).broadcast('peer.joinRequest', { keyHash, ticket, joiner: {
  connId, role, info } })`. Return `{ self }`. The server does not know whether anyone owns the room.
- **`peerAdmit`**: authority is the secret, **not** room membership (a host that lets clients join rooms
  by name must not be able to grant owner powers). Recompute `roomKey` from `ownerSecret`. Emit
  `peer.admitted` to the joiner **first**, with `by` = the sender's server-verified `{ connId, role }`,
  then (when accepted) `peer.joined` to each listed member.
- **`peerRemove`**: same secret check; emit `peer.left` to the listed members and to the removed member.
- **`peerSignal`**: stamp `from = { connId: conn.id, role: conn.role }` and `ctx.toConn(to).emit('peer.signal',
  …)`. No membership check and no `authorize` call (it runs once per ICE candidate); receivers filter.

The owner room is only the mailbox for join requests. Its name is a one-way hash and may be visible.

## Client half

One `peerClient` per `SuperLineClient`. It checks every inbound event's envelope shape itself (client
inbound validation is off by default).

### Trust rules

- Act on `peer.admitted` only when there is a pending join for that `roomKey`.
- Act on `peer.joined` / `peer.left` only for a `roomKey` this client holds.
- A member set for a room comes only from those server-emitted events (the creator's own set comes from
  its own admissions). The joiner always adds `by` to its member set.
- Drop a `peer.signal` unless this client holds the `roomKey` **and** `from.connId` is in that room's
  member set.
- **Bounded buffer**: while a join for a key is pending or the room is held, hold `peer.signal` and
  `peer.joined` frames from connection ids not yet in the member set (cap 32 per sender, 33 × 32 per key
  so a full room cannot overflow it, and at most 512 KB of frames per key, TTL = join timeout). Replay in arrival order when that sender becomes a member; discard on reject or
  timeout. Cross-node delivery order is not guaranteed, and perfect negotiation never re-sends an offer.

### Create / join / admit

- `createRoom`: generate `ownerSecret` with `crypto.getRandomValues`, send `peerCreateRoom`. Keep the
  secret in memory only.
- `join(key)`: generate a `ticket` (once per joined key), send `peerJoin`, hold a pending join with a
  timeout (default 30 s) → resolve on `peer.admitted { accept: true }`, reject `FORBIDDEN` on
  `accept: false`, `TIMEOUT` otherwise. Joining a key already held returns the existing room; joining a
  key this client created rejects.
- Creator, on `peer.joinRequest` whose `keyHash` matches one of its rooms: ignore its own id and ids
  already members; if the `ticket` was accepted before, auto-accept and **replace** the old member that
  held that ticket (close its link, and send `peerRemove` for the old id to the remaining members so
  they drop it at once instead of waiting for their liveness timeout); otherwise run `accept(joiner)`.
  Reject when the room is at `maxMembers`. Admissions are serialized (one at a time); queue at most 8
  pending requests per room and drop the overflow. Send `peerAdmit` with the current member list, add the joiner to the list, and
  start the link to it.

### Links

- One `RTCPeerConnection` per `(roomKey, remote connId)`.
- MDN **perfect negotiation** on every link, `polite = myConnId > theirConnId`, computed once when the
  link is created. Only the impolite side makes the first offer; the polite side answers it (see
  "What real browsers changed").
- Whoever learns of the other member creates the link: existing members on `peer.joined`, the newcomer
  for every entry of `peer.admitted.members`, the creator when it sends the admit.
- Data channels are `negotiated: true` on both sides: id `0` is an internal reliable control channel;
  user channels get ids `1..n` in sorted-name order. `reliable: false` ⇒ `{ ordered: false,
  maxRetransmits: 0 }`. `binaryType = 'arraybuffer'`.
- Remote ICE candidates are buffered until the remote description is set.
- **Hello**: the first control message is `{ from: myConnId, to: theirConnId, roomKey }`; the receiver
  closes the link unless `from` is the link's server-stamped peer and `to` is its own id (stops an
  admitted member relaying someone else's SDP under its own identity).
- Link state is `open` once the hello has been verified and every channel is open.
- **Connect timeout**: a link not open within 15 s is closed and marked `failed`.
- **Liveness**: any inbound message on any channel counts as "heard"; send a control ping after 1 s of
  idle; declare the peer gone after 3 s of silence. Send a control `bye` on `leave()` and on `pagehide`.
  The creator's `leave()` and `p.close()` send `end` instead; a member that hears `end` from the creator
  closes the room with `'ended'` and does not re-join.
- Closing a link closes every data channel and then the peer connection (Node hosts hang otherwise).

### Sending and receiving

- Encode with the `serializer` option (default core's `jsonSerializer`).
- `send()` broadcasts only to links whose channel is `open`; it never throws because one link is not
  ready. On a `reliable: false` channel, skip a link whose `bufferedAmount` is above a small threshold.
  `to(id).send()` throws when that link is not open. An encoded message larger than the link's
  `sctp.maxMessageSize` (fallback 65536) throws a typed `SuperLineError`.
- Receive: check the raw size against a per-channel `maxBytes` (default 65536) → decode → validate
  synchronously against the channel schema → deliver the **parsed output** with `from` = the link's
  member. Failures go to `onError(err, { room, channel, member })`; the message is dropped.

### Membership view

`room.members` is the admitted set minus explicit departures (`bye`, `peer.left`, or liveness loss after
the link was once open). A pair that never connects stays listed with `link: 'failed'`. Only the
creator's own connect timeout removes a member from the list it sends in admissions.

### Reconnect and automatic re-join

- Creator, on `client.onReconnect`: keep its links and member list; re-send `peerCreateRoom` with the
  saved `ownerSecret` for each room it owns (same key). `self.id` updates when that answers; an
  admission waits for it, so `peer.admitted.by` and the new link agree on the creator's id. Each link
  keeps the id and `polite` it was created with, so existing members keep the creator's old id.
- Joiner: re-send `peerJoin(roomKey, ticket)` from `client.onReconnect`, on `visibilitychange` →
  `visible` when its link to the creator is not open, and when that link closes (the creator is removed
  from the member list: `bye`, liveness loss, or a channel closing after open). A link to the creator
  that fails before it ever opened does not start a re-join; the next `visible` does.
- Retry: one `peerJoin` per attempt, the next after `rejoinBaseMs` (500) doubling up to `rejoinMaxMs`
  (5000); an attempt is only spent while the client is connected (a reconnect re-drives it, a `visible`
  retries at once). After `rejoinAttempts` (8) the room closes with `'lost'`. It stops with `'refused'`
  on `FORBIDDEN` from `peerJoin` or `peer.admitted { accept: false }`, `'kicked'` on `peer.left` naming
  the current or the re-joining id, `'left'` on `leave()`, `'closed'` on `p.close()`.
- While re-joining, `room.state` is `'rejoining'` and inbound `peer.signal` / `peer.joined` for the room
  are held in the same bounded buffer, then replayed once the re-join settles.
- On `peer.admitted`: when the connection id changed, every member is removed (`'left'` events) and the
  room is rebuilt from `by` + `members` (`'joined'` events). When it did not, the creator's entry, any
  member not in the fresh list and any member whose link is not open are rebuilt; open links stay. The
  room object stays the same; `onClose` fires only when re-join gives up or is refused.
- The creator only re-admits a returning id it no longer lists, so a re-join under the same id waits for
  the creator's own liveness or connect timeout to drop the old entry.
- A plugin-auth session replacement builds a new `SuperLineClient`; the app builds a new `peerClient`.
  Documented, not automated.

## Documented limits (trust model)

- The server brokers and authorizes admission; it never sees, validates or revokes peer payloads. Kick
  and membership are enforced by honest clients.
- Members learn each other's connection ids (the session id under plugin-auth) and public IP addresses.
  `iceTransportPolicy: 'relay'` hides IPs at TURN cost.
- Hosts running the inspector must redact `ownerSecret`, `roomKey`, `ticket`, `sdp`, `candidate`.
- Hosts should rate-limit `peerJoin` / `peerSignal` / `peerAdmit` with middleware.
- Both peers must reach the same node or cluster (on Cloudflare, the same Durable Object name).
- Phones: hold a Screen Wake Lock while linked; recommend `reconnectMaxMs ≈ 3000` and keepalive on.
- A member that calls `leave()` before its links are open cannot send `bye`. Its own state is clean
  (links closed, timers cleared, room gone), but the others see that member go `connecting` → `failed`
  at their connect timeout; the creator drops it from its list at the same point.
- When the creator leaves or closes, joiners close at once with `'ended'`. A creator that merely
  disconnects, crashes or closes its tab without `leave()` sends no `end`: joiners see its link close and
  re-join until they give up (`'lost'`, about 30 s with the defaults). A joiner already re-joining when
  the creator leaves never hears the `end` either.

## Decisions made during implementation

- A data channel that closes, or a peer connection that reaches `failed`/`closed`, after the link was
  open counts as an immediate departure (same as `bye`), not as a link-state change.
- User messages that arrive before the hello is verified are held (up to 64 per link) and delivered
  once it is, or dropped if the link closes first.
- `maxMembers` counts the creator: range 2..33, default 33, so the wire cap of 32 listed members holds.
- Error codes: `FORBIDDEN` (create or join denied, room cap, creator rejected the join, non-creator
  `kick`, hello mismatch reported to `onError`), `TIMEOUT` (nobody admitted the join), `BAD_REQUEST`
  (no `RTCPeerConnection`, `createRoom` without `crypto.subtle` (a plain-HTTP page on a LAN address;
  `join` does not need it), bad `maxMembers`, joining your own room, a message over the link or channel
  limit), `NOT_FOUND` (unknown channel or member), `DISCONNECTED` (`to(id)` on a link that is not open,
  peer client closed), `VALIDATION` (an inbound message fails its channel schema; wire input bounds).
- `members[].role` is filled from the first server-stamped `peer.signal` from that member, so it may be
  `undefined` until then (the creator knows each joiner's role from its join request, and a joiner
  knows the creator's from `peer.admitted.by`).
- A returning ticket replaces the old member even while its link still looks open. A ticket therefore
  grants a seat on its own; hosts must redact `ticket` in the inspector along with the other secrets.
- **Early frames have a byte budget.** The held-frame buffer also stops at 512 KB per key, counted as
  the UTF-8 length of each frame's JSON. The count caps alone let anyone who knows a room key make a
  joining client hold 33 × 32 frames of up to 64 KB of SDP each (about 70 MB) for the join timeout.
  Measured with node-datachannel 0.32.3 on a host with seven interfaces, one link's signaling is an
  offer or answer of about 1.2 KB and about 300 B per candidate (3.2–3.5 KB per sender in total), so a
  sender at its 32-frame cap with real frames holds about 10.5 KB, and a full room of them about
  350 KB. Chrome (same host, the example's STUN server) sends a 650 B offer and about 375 B per
  candidate, about 1.6 KB per sender. Frames past the budget are dropped like frames past the count
  caps.

### What real WebRTC changed (ticket 4, node-datachannel 0.32.3 / libdatachannel)

- **Closing order.** A link closes its data channels and closes the peer connection only once every
  channel has reported `close` (or after a 1 s grace). Closing the peer connection straight after
  `dc.close()` left a native channel half-closed in libdatachannel (the polyfill defers the native
  channel close to `setImmediate`, which then runs against a closed connection), and that channel kept the
  Node process alive (2 of 15 probe runs hung, 0 of 23 with the wait). Browsers are unaffected by it.
- **Farewells are delivered before the close.** `bye` and `end` are sent on the control channel, then the
  control channel alone is closed; the user channels and the peer connection close after it reports
  `close`. libdatachannel's peer connection `close()` drops data still in flight, so the old
  send-then-close lost every `bye` (browser behaviour was not measured; the wait costs one round trip).
  The receiver gets the farewell strictly before any close on that link, because the control channel is
  ordered.
- **Implementations that negotiate on their own.** libdatachannel sets a local offer as soon as the first
  channel is created and never fires `negotiationneeded`, answers a remote offer inside
  `setRemoteDescription`, treats a parameterless `setLocalDescription()` as a no-op, and does implicit
  rollback. The link sends its local offer right after creating the channels when the connection is
  already in `have-local-offer` (never true in a browser at that point), and the rest of perfect
  negotiation runs unchanged: every pair collides, the polite side rolls back, and no explicit
  `{ type: 'rollback' }` is needed.
- **Candidate buffering keys on the link's own state.** Remote candidates are held until this link has
  applied a remote description, tracked by the link, not by reading `pc.remoteDescription`
  (libdatachannel returns an empty description object instead of `null`, so every early candidate was
  handed to `addIceCandidate` and rejected).
- **`maxMessageSize` is read live.** The polyfill reports `sctp.maxMessageSize` only while connected
  (262144 on localhost); the 65536 fallback applies before that. Messages between 64 KB and the live
  limit are delivered.
- **An admission waits for the creator's connection.** When the creator's connection drops after its
  re-claim was awaited but before `peerAdmit` goes out, the admission now waits for the next reconnect
  and its re-claim, so `peer.admitted.by` and the new link agree on the creator's id. An in-flight
  `peerAdmit` that fails with `DISCONNECTED` still drops the joiner from the creator's list; if the server
  had already delivered it, that joiner's link times out to `failed` and it re-joins on the next
  `visible`.
- **Tests.** The integration lane runs `test/rtc.integration.test.ts` against the polyfill with no ICE
  servers (host candidates on localhost). A link takes about 1 s (libdatachannel's first DTLS flight is
  retransmitted after 999 ms), so link waits have a 10 s ceiling; liveness runs at its 1 s / 3 s
  defaults. A child Node process built from `test/rtc-exit.ts` must exit on its own after `leave()` and
  `p.close()`. The fast lane's fake can mimic libdatachannel's negotiation
  (`createFakeNetwork({ libdatachannel: true })`) and counts peer connections closed before their
  channels (`net.leaked`), so both regressions show up without the native stack.

### What real browsers changed (ticket 5, Chrome, `examples/peer-controller`)

- **Only the impolite side makes the first offer.** In Chrome, a polite joiner whose own first offer
  collided with the creator's rolled it back (implicit rollback on `setRemoteDescription`), answered,
  and then the link never connected: in 7 such trials 5 stayed `connecting` until the connect timeout,
  some with no local candidate ever gathered after the rollback; every trial without a rollback (9 of
  9) connected. The polite side now skips `negotiationneeded` until it has applied a remote
  description, so a browser pair never collides on its first offer. libdatachannel still sets a local
  offer on its own and rolls it back as before. Perfect negotiation stays in place for anything later.

## Tickets

1. **Package scaffold + contract + server half.** Fast-lane loopback tests drive the five requests and
   five events with plain clients (one node, and two nodes on a shared in-memory bus).
2. **Client half core**: rooms, admission, links, negotiation, buffering, channels, validation,
   liveness, timeouts, kick/leave. Fast-lane tests with an in-memory fake `RTCPeerConnection`.
3. **Reconnect and automatic re-join** with tickets.
4. **Real WebRTC tests** with `node-datachannel` in the integration lane (adds the dev dependency).
5. **`examples/peer-controller`**: a desktop "TV" page and a phone controller page.
6. **Docs**: ADR-0030, how-to page, package README, root README, the four `skills/super-line/` files,
   rewording of the "no client-to-client path" statements, CLAUDE.md layout line.
