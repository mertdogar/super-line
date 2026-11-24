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
const p = peerClient(client, peerFragment, { iceServers, serializer?, rtc?, onError? })

const room = await p.createRoom({ accept: (joiner) => true, maxMembers: 8 })
room.key                                  // long random string → QR code / link
const room = await p.join(key)            // resolves on admission

room.self                                 // { id, role }
room.members                              // [{ id, role?, info?, link: 'connecting' | 'open' | 'failed' }]
room.onMember((event) => ...)             // joined | left | link-state change
room.channel('input').send(msg)           // every member whose link is open
room.channel('input').to(memberId).send(msg)
room.channel('input').on((msg, from) => ...)   // returns an unsubscribe
room.kick(memberId)                       // creator only
room.leave()
room.onClose((reason) => ...)
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
  `peer.joined` frames from connection ids not yet in the member set (cap ~32 per sender, ~64 per key,
  TTL = join timeout). Replay in arrival order when that sender becomes a member; discard on reject or
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
  held that ticket (close its link); otherwise run `accept(joiner)`. Reject when the room is at
  `maxMembers`. Admissions are serialized (one at a time); queue at most 8 pending requests per room and
  drop the overflow. Send `peerAdmit` with the current member list, add the joiner to the list, and
  start the link to it.

### Links

- One `RTCPeerConnection` per `(roomKey, remote connId)`.
- MDN **perfect negotiation** on every link, `polite = myConnId > theirConnId`, computed once when the
  link is created.
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
  saved `ownerSecret` for each room it owns (same key). `self.id` updates; `polite` stays fixed per link.
- Joiner: re-send `peerJoin(roomKey, ticket)` from `client.onReconnect`, on `visibilitychange` →
  `visible` when its link to the creator is not open, and when that link closes. Retry with backoff;
  stop on an explicit reject, a kick (`peer.left` naming itself), or `leave()`. On a successful re-join
  the client has a new connection id: drop links to members under the old identity and rebuild from the
  fresh `peer.admitted.members`.
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
