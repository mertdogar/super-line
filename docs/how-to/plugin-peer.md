# Direct client-to-client rooms — `@super-line/plugin-peer`

`@super-line/plugin-peer` lets two or more super-line **clients** exchange data directly over WebRTC
data channels. The super-line server admits each member and relays the WebRTC handshake; after that,
messages travel from client to client and the server carries none of them.

Reach for it when the server hop costs too much: phones acting as game controllers for a game on a
desktop screen, a second device driving a presentation, low-latency input between two tabs. For
everything else, keep using requests, events, and topics: they go through the server, which validates
and authorizes every message. Peer messages don't, and the [trust model](#trust-model) section spells out
what that means.

```bash
pnpm add @super-line/plugin-peer
```

It is a paired plugin with three entry points: `.` (the contract fragment), `/server`, and `/client`.

::: warning Peer messages bypass the server
The server decides who may create a room and who may ask to join one, and it stamps each member's
identity on the handshake. It never sees, validates, or revokes the messages members send each other.
The **receiving** client validates every message against the channel's schema. Read
[Trust model](#trust-model) before you send anything a member must not be able to forge.
:::

## Wire it in

Declare your channels once in the contract fragment, mount the server half, and wrap each client.

### 1 · Contract

`peerContract({ channels })` declares the data channels. Each channel has a
[Standard Schema](https://standardschema.dev) (`schema`), and channels are symmetric: both ends send
and receive the same schema. Put the fragment in `defineContract({ plugins })`; it adds the
plugin's signaling requests and events to the `shared` surface of every role.

```ts [contract.ts]
import * as z from 'zod'
import { defineContract } from '@super-line/core'
import { peerContract } from '@super-line/plugin-peer'

const axis = z.number().min(-1).max(1)

export const controls = peerContract({
  channels: {
    stick: { schema: z.object({ x: axis, y: axis }), reliable: false, maxBytes: 256 },
    events: {
      schema: z.discriminatedUnion('type', [
        z.object({ type: z.literal('press'), button: z.literal('a') }),
        z.object({ type: z.literal('bump') }),
      ]),
    },
  },
})

export const contract = defineContract({
  roles: { screen: {}, controller: {} },
  plugins: [controls],
})
```

Keep the `controls` object: the client half reads the channel schemas from it.

### 2 · Server

`peer({ authorizeCreate, authorize })` from `@super-line/plugin-peer/server` returns `{ plugin }`.
Both hooks are required and deny by default: a missing hook or a `false` result rejects with
`FORBIDDEN`.

```ts [server.ts]
import { createSuperLineServer } from '@super-line/server'
import { peer } from '@super-line/plugin-peer/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { contract } from './contract.js'

createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server, path: '/ws' })],
  authenticate: (h) => ({
    role: h.query.role === 'screen' ? 'screen' : 'controller',
    ctx: { name: (h.query.name ?? '').slice(0, 24) || 'Player' },
  }),
  plugins: [
    peer<{ name: string }>({
      authorizeCreate: ({ creator }) => creator.role === 'screen',
      authorize: ({ ctx }) => ({ info: { name: ctx.name } }),
    }).plugin,
  ],
})
```

| Option | Default | Meaning |
| --- | --- | --- |
| `authorizeCreate({ creator, ctx })` | required | Who may create a room. `creator` is the connection's `ConnDescriptor`. Returns `boolean` or a promise of one. |
| `authorize({ joiner, roomKey, ctx })` | required | Who may ask to join `roomKey`. Returns `false`, `true`, or `{ info }`. |
| `maxRoomsPerConn` | `8` | Rooms one connection may own at the same time. Past it, `createRoom` rejects with `FORBIDDEN`. |

`info` is a public descriptor of the joiner that you choose, such as a display name. The server stamps it
into the join request, so the room's creator decides on identity the server attested, and every member
sees it on `room.members`. It's a flat map of at most 16 fields: keys up to 64 characters, values a
string (up to 256 characters), a number, a boolean, or `null`. An `info` outside those bounds fails the
join with `VALIDATION`.

The server half keeps no state of its own. The only footprint is one server room per peer room,
named `peer-owner:<hash>`, which is how join requests reach the creator.

### 3 · Client

`peerClient(client, fragment, options?)` from `@super-line/plugin-peer/client` wraps one connected
`SuperLineClient`. Pass the same fragment you put in the contract.

```ts [screen.ts]
import { createSuperLineClient } from '@super-line/client'
import { peerClient } from '@super-line/plugin-peer/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { contract, controls } from './contract.js'

const client = createSuperLineClient(contract, {
  transport: webSocketClientTransport({ url: 'wss://game.example.com/ws' }),
  role: 'screen',
  params: { role: 'screen' },
})

const peers = peerClient(client, controls, {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
})
```

`peerClient` throws `BAD_REQUEST` when the runtime has no `RTCPeerConnection` and you didn't pass
`rtc` (see [Node hosts](#node-hosts)). Call `peers.close()` to leave every room, close every link, and
detach from the client. It doesn't close the super-line client itself.

## Create a room and share its key

The creator calls `createRoom`. `accept` runs once for every join request and decides admission; a
falsy result or a throw rejects the joiner.

```ts
const room = await peers.createRoom({
  accept: (joiner) => joiner.role === 'controller',
  maxMembers: 9,
})

showQrCode(`https://game.example.com/c#${room.key}`)
```

`accept` receives `{ id, role, info? }`: the joiner's connection id and role as the server verified
them, and the `info` your `authorize` returned. `maxMembers` counts the creator and ranges from 2 to 33
(default 33). A join that arrives while the room is full is rejected.

`room.key` is a 43-character random string. Anyone who holds it can **ask** to join; `authorize` and
`accept` still decide. Share it the way you would share an invite link, for example in a QR code or a
URL fragment, and keep it out of logs.

`createRoom` rejects with:

- `FORBIDDEN` when `authorizeCreate` denies it or the connection already owns `maxRoomsPerConn` rooms.
- `BAD_REQUEST` when `maxMembers` is out of range, or when `crypto.subtle` is missing, which is the case
  on a plain-HTTP page served from a LAN address (see [Secure contexts](#secure-contexts)).

## Join a room

A member calls `join(key)`. The promise resolves once the creator admits it.

```ts
const room = await peers.join(location.hash.slice(1))
```

The server doesn't know whether a room exists. It forwards the join request to whoever owns the key,
so a key nobody owns times out rather than failing at once.

| Rejection | When |
| --- | --- |
| `FORBIDDEN` | `authorize` denied the join, `accept` returned false or threw, or the room is full. |
| `TIMEOUT` | Nobody admitted the join within `joinTimeoutMs` (default 30 s): no such room, the creator is offline, or its queue of pending requests was full. |
| `VALIDATION` | The key isn't a well-formed room key. |
| `BAD_REQUEST` | You created this room yourself. |
| `DISCONNECTED` | The peer client was closed. |

Calling `join` again with a key you already hold returns the same room. The creator admits requests
one at a time and queues at most 8 per room; requests past that are dropped and time out.

## Members and links

`room.members` lists every other member, each with the state of **your** direct link to it. Each
member links to every other member: a room is a full mesh.

```ts
room.self // { id, role }: your own connection id and role
room.members // [{ id, role?, info?, link: 'connecting' | 'open' | 'failed' }]

room.onMember(({ type, member }) => {
  if (type === 'joined') addPlayer(member)
  if (type === 'left') removePlayer(member.id)
  if (type === 'link') setLinkState(member.id, member.link)
})
```

- `joined` fires when a member enters your view of the room, `left` when it leaves, and `link` when
  your link to it opens or fails.
- A link is `open` once both sides have verified each other and every channel is open. A link that
  doesn't open within `connectTimeoutMs` (default 15 s) becomes `failed`, and the member stays listed
  with `link: 'failed'` until it leaves. On the creator's side, a member whose link never opens is
  removed instead, so new members aren't told to link to it.
- A member leaves your view when it says goodbye (`leave()`, closing its page, or `peers.close()`),
  when the creator kicks it, when an open link closes, or when an open link goes silent for
  `livenessTimeoutMs` (default 3 s).
  Each side sends a small ping after `pingIdleMs` (default 1 s) without other traffic, so a healthy
  idle link never times out.
- `member.role` can be `undefined` for a short time: a member learns another member's role from the
  first handshake message it relays. The creator knows each joiner's role from its join request, and a
  joiner knows the creator's from its admission.

## Room state and close reasons

`room.state` is `'active'`, `'rejoining'` (a joined room re-joining after a disconnect; see
[Reconnect and re-join](#reconnect-and-re-join)), or `'closed'`. `onState` fires on every change, and
`onClose` fires once with the reason.

```ts
room.onState((state) => renderState(state))
room.onClose((reason) => showClosed(reason))
```

| Reason | Meaning |
| --- | --- |
| `left` | You called `room.leave()`. |
| `closed` | You called `peers.close()`. |
| `kicked` | The creator kicked you. |
| `ended` | The creator left the room, closed its peer client, or lost the room on a refused re-claim. Joiners only. |
| `refused` | A joiner's re-join was denied, by `authorize` or by the creator, or `authorizeCreate` denied the creator's re-claim. |
| `lost` | A re-join ran out of attempts. |

## Kick and leave

The creator removes a member with `kick`. Other callers get `FORBIDDEN`.

```ts
await room.kick(memberId)
```

Kicking closes the creator's link to that member, tells the remaining members to drop it, and tells
the kicked member, whose room closes with `kicked`. The creator also forgets the member's admission
ticket, so if that member asks to join again, `accept` decides afresh. A kick isn't a ban: refuse the
member in `accept` (or in `authorize`) to keep it out.

`room.leave()` says goodbye on every open link and closes the room with `left`. When the creator
leaves, every joiner's room closes with `ended`, and the creator stops receiving join requests for that
key.

A member that leaves before any of its links has opened can't say goodbye. Its own state is clean, but
the others see its link go from `connecting` to `failed` at their connect timeout.

## Channels

A channel sends to every member at once or to one member. Messages are typed from the channel's
schema.

```ts
const events = room.channel('events')

events.send({ type: 'bump' }) // every member whose link is open
events.to(memberId).send({ type: 'bump' }) // one member

const off = events.on((message, from) => {
  // message is the schema's parsed output; from is the member whose link carried it
})
off()
```

### Reliable and lossy channels

A channel is reliable and ordered by default. `reliable: false` makes it unordered with no
retransmits: a lost message stays lost, and a late one can arrive after a newer one. Use it for state
you resend continuously, such as a stick position on every animation frame, and send absolute values
rather than deltas.

On a lossy channel, a send to a link whose buffer holds more than `lossyBufferedAmount` (default 16384
bytes) is skipped, so a slow link drops input instead of building a backlog.

### Sending

- `send()` goes to every member whose link is open and skips the rest. It never throws because one
  link isn't ready.
- `to(id).send()` throws `NOT_FOUND` when there's no such member and `DISCONNECTED` when your link to
  it isn't open.
- `room.channel(name)` throws `NOT_FOUND` for a channel that isn't declared.
- An encoded message larger than the link's maximum message size throws `BAD_REQUEST` before anything
  is sent. The browser reports that limit once the link is connected; until then it's 65536 bytes.

Encoding uses the `serializer` option, which defaults to core's JSON serializer. Every member must use
the same one.

### Receiving and validation

Each inbound message is checked against the channel's `maxBytes` (default 65536) before it is decoded,
then validated against the channel schema. Handlers receive the **parsed output**, so a schema that
transforms or coerces delivers the transformed value. A message that is too large, fails to decode, or
fails validation is dropped and reported to `onError`; it never reaches a handler.

Validation is synchronous. A schema whose validation is asynchronous fails every message with
`INTERNAL`.

### Errors

`onError(error, info)` receives dropped inbound messages, handlers that throw, failed links, and
signaling requests that failed. `info` carries the `room`, the `channel`, and the `member` where they
apply.

```ts
const peers = peerClient(client, controls, {
  onError: (error, { channel, member }) => console.warn('peer', channel, member?.id, error),
})
```

By default, errors are logged as a LogTape warning under `['super-line', 'plugin-peer', 'client']`,
with the channel and member id but never the room key.

## Reconnect and re-join

Links between members don't go through the server, so they keep working while a member's server
connection is down. Rooms recover on their own once it comes back.

**The creator** re-claims each room it owns when its client reconnects. The room keeps the same key,
links stay open, and `room.self.id` changes to the new connection id. Admissions wait until the
re-claim has gone through. If `authorizeCreate` denies the re-claim, the room closes with `refused` and
ends for its members, who close with `ended`. A re-claim that fails for any other reason, such as a
timeout, leaves the room open and runs again on the next reconnect.

**A joiner** re-joins the room, with the same ticket, when any of these happens:

- Its client reconnects.
- Its link to the creator closes after it had opened (the creator said goodbye without leaving, or
  went silent).
- The page becomes visible again while its link to the creator isn't open.

While it re-joins, `room.state` is `'rejoining'`. Attempts back off from `rejoinBaseMs` (500 ms),
doubling up to `rejoinMaxMs` (5 s), and an attempt only counts while the client is connected. After
`rejoinAttempts` (8) attempts, about 30 seconds with the defaults, the room closes with `lost`. A
denied re-join closes it with `refused`.

The creator admits a returning ticket without calling `accept`, and replaces the member that held it.
When a re-join succeeds under a new connection id, every member is reported `left` and then `joined`
again, and the links are rebuilt. Under the same id, open links stay. The room object stays the same
throughout, so keep your listeners.

A creator that only loses its server connection keeps its links, so joiners don't notice. A creator
that crashes or closes its page without calling `leave()` looks like a dropped link to the joiners:
they re-join until they give up with `lost`. Because a reconnect gives a joiner a new connection id,
a joiner's own server reconnect rebuilds its links even when they were still open.

::: warning A link that never opened doesn't trigger a re-join
When a joiner's link to the creator fails before it ever opened, the joiner doesn't re-join on its own.
The next time the page becomes visible it does. Offer a retry button: call `room.leave()` and then
`peers.join(key)` again. The peer client reuses the room's ticket, so a creator that admitted it before
admits it again without calling `accept`.
:::

With `@super-line/plugin-auth`, a sign-in or sign-out replaces the `SuperLineClient`. Close the old
peer client and build a new one for the new client; the plugin doesn't follow the replacement.

## Configure ICE (STUN and TURN)

A link needs a direct network path between two members. `iceServers` lists the STUN and TURN servers
that help find one.

```ts
const peers = peerClient(client, controls, {
  iceServers: async () => {
    const turn: RTCIceServer = await fetch('/turn-credentials').then((r) => r.json())
    return [{ urls: 'stun:stun.l.google.com:19302' }, turn]
  },
})
```

`iceServers` takes an array or a function. The function runs for every new peer connection, so it can
fetch short-lived TURN credentials from an endpoint or request of your own (`/turn-credentials` above
is yours, not part of the plugin).

- **STUN** is enough on the same Wi-Fi network and across most home routers. It's what lets a member
  learn its public address.
- **TURN** is required when no direct path exists: guest, venue, and office networks that isolate
  clients from each other, a phone on cellular data reaching a computer behind a strict or symmetric
  NAT, and routers that don't support hairpinning. Run a TURN server (coturn or a hosted one) and list
  it.
- `iceTransportPolicy: 'relay'` forces every link through TURN. It hides members' IP addresses from
  each other, at the cost of relaying all traffic.

There is no fallback through the super-line server. A pair that can't connect directly shows
`link: 'failed'`.

## Secure contexts

Browsers only expose some APIs to secure contexts: pages served over HTTPS or from `localhost`.
`http://192.168.1.20` is not one.

| API | Needs a secure context | Used for |
| --- | --- | --- |
| `RTCPeerConnection` and data channels | No | Every link |
| `crypto.getRandomValues` | No | The join ticket |
| `crypto.subtle` | **Yes** | `createRoom`, which derives the room key |
| Screen Wake Lock | **Yes** | Keeping a phone controller awake (your code, not the plugin) |

So `join` works on a plain-HTTP LAN page, but `createRoom` rejects with `BAD_REQUEST` there. For local
development, open the creating page at `localhost` and let other devices join over the LAN address, or
serve everything over HTTPS.

## Trust model

The plugin moves data off the server on purpose, so the server's usual guarantees don't cover it.

**What the server does:**

- Decides who may create a room (`authorizeCreate`) and who may ask to join one (`authorize`).
- Stamps the sender's server-verified connection id and role on every join request and every relayed
  handshake message, so a member can't claim another member's identity.
- Proves who owns a room: only the client holding the room's secret can admit, remove, or re-claim.
  Joining the server room with the same name grants nothing.

**What the server doesn't do:**

- It never sees, validates, stores, or revokes the messages members send each other. Each receiving
  client validates against the channel schema, which is why `maxBytes` and tight schemas matter: a
  modified client can send anything that fits.
- It doesn't enforce membership or kicks. The creator and the other members honor them. A link that is
  already open survives the server disconnecting or revoking either end.
- It doesn't hide members from each other. Members learn each other's connection ids (the session id
  under plugin-auth) and, through ICE, their IP addresses. Use `iceTransportPolicy: 'relay'` to hide
  addresses.

**Secrets.** The room key lets anyone ask to join. An admission ticket on its own grants a seat: a
returning ticket is admitted without `accept` and replaces the member that held it. The creator's room
secret grants ownership. All three, and the handshake contents, cross the server and can show up in
the Control Center; redact them (see [Operate it](#operate-it)).

## Operate it

The plugin needs no infrastructure of its own, but a few server-side settings matter in production.

- **Redact secrets in the inspector.** If you run the Control Center, mask the plugin's secret and
  handshake fields:

  ```ts
  plugins: [
    inspector({ redact: ['ownerSecret', 'roomKey', 'ticket', 'sdp', 'candidate'] }),
    peer({ authorizeCreate, authorize }).plugin,
  ]
  ```

- **Rate-limit signaling.** Joins and relayed handshake messages are ordinary requests, so `use`
  middleware sees them before they are validated. Limit `peerJoin`, `peerSignal`, and `peerAdmit` per
  connection:

  ```ts
  use: [
    async (_ctx, info, next) => {
      if (info.kind === 'request' && info.name.startsWith('peer')) rateLimit(info.conn?.id, info.name)
      await next()
    },
  ]
  ```

- **Put members on the same node or cluster.** Handshake messages reach a member through the server
  it's connected to, so every member must reach the same node or the same cluster (through an
  adapter). On Cloudflare, that means the same Durable Object name: put the route in the join link
  along with the key.
- **Observability stops at the handshake.** The Control Center and the client DevTools panel show the
  plugin's requests and events (`peerJoin`, `peer.signal`, and so on), never channel messages.

## Phone controllers

A phone browser that goes to the background or locks its screen suspends the page, and its links die.
A few habits keep a controller usable.

- **Hold a Screen Wake Lock** while the controller is linked, and take it again when the page becomes
  visible: browsers release it whenever the page is hidden. It needs a secure context.
- **Reconnect quickly.** Create the phone's client with `reconnectMaxMs` around `3000` and `keepalive`
  on, so a dropped server connection comes back fast.
- **Treat lossy input as stale.** On the screen, record when each stick message arrived and reset the
  input to neutral when none has arrived for about 200 ms. Otherwise a controller that vanishes keeps
  steering until its link times out.
- **Offer "Join again".** Show it when the room closes and when the link to the screen is `failed`
  (see [Reconnect and re-join](#reconnect-and-re-join)).

The [`peer-controller`](https://github.com/mertdogar/super-line/tree/main/examples/peer-controller)
example does all four.

## Node hosts

Node has no built-in `RTCPeerConnection`. Pass one with `rtc`, for example the polyfill from
`node-datachannel`, and turn off the page listeners with `document: null`:

```ts
import { RTCPeerConnection } from 'node-datachannel/polyfill'

const peers = peerClient(client, controls, {
  rtc: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
  document: null,
})
```

Outside a browser, `document` defaults to `globalThis.document`, which is undefined, so `null` only
makes the choice explicit. Closing a link closes its data channels before its peer connection, so
open links don't keep a Node process alive after `leave()` and `peers.close()`.

## Client options

Every `peerClient` option is optional.

| Option | Default | Meaning |
| --- | --- | --- |
| `iceServers` | none | `RTCIceServer[]`, or a function returning them, called for every new peer connection. |
| `iceTransportPolicy` | browser default | Passed to `RTCPeerConnection`. `'relay'` forces TURN. |
| `serializer` | core's `jsonSerializer` | Channel encoding. Every member must use the same one. |
| `rtc` | `globalThis.RTCPeerConnection` | The `RTCPeerConnection` constructor. |
| `onError` | LogTape warning | Dropped messages, failed links, and failed signaling. |
| `joinTimeoutMs` | `30000` | How long `join` waits for admission. |
| `connectTimeoutMs` | `15000` | A link not open by then becomes `failed`. |
| `pingIdleMs` | `1000` | Send a ping after this long without sending on a link. |
| `livenessTimeoutMs` | `3000` | Drop a member after this long without hearing from it. |
| `lossyBufferedAmount` | `16384` | A lossy channel skips a link whose buffer holds more bytes than this. |
| `rejoinAttempts` | `8` | Re-join attempts before the room closes with `lost`. |
| `rejoinBaseMs` | `500` | Delay before the first re-join retry; it doubles each time. |
| `rejoinMaxMs` | `5000` | Longest delay between re-join retries. |
| `document` | `globalThis.document` | Where `visibilitychange` and `pagehide` are heard. `null` turns both off. |

## Limits

Know these before you design around the plugin.

- **Full mesh.** A room of `n` members has `n × (n − 1) / 2` links, and each member holds `n − 1` peer
  connections, even when your app only talks to one member. The 33-member cap is 528 links.
- **Browsers only, plus Node through `rtc`.** Smart-TV web runtimes are unsupported: most don't offer
  WebRTC to third-party pages. Connect a computer with a desktop browser to the TV instead.
- **No relay through the server.** A pair without a direct path or TURN can't connect.
- **No React hooks.** Use the vanilla client from components.
- **What has been tested.** Links, channels, the full mesh, liveness, and re-join run in automated tests
  against `node-datachannel` (libdatachannel). Desktop Chrome was tested by hand with the example. A
  real phone, TURN, Firefox, and Safari have not been tested.

## Next steps

- Try the [live demo](https://super-line-peer-controller.dogar.workers.dev/) on a computer and a phone: it is the example below, deployed as a Cloudflare Worker.
- Run the [`peer-controller`](https://github.com/mertdogar/super-line/tree/main/examples/peer-controller)
  example: phones drive dots on a desktop screen, and stopping the server doesn't stop them.
- Read [Server-authoritative design](/concepts/server-authoritative) for the model this plugin makes an
  exception to.
- See [Middleware & lifecycle](/how-to/middleware-lifecycle) for the `use` chain and
  [Control Center](/how-to/control-center) for the inspector's `redact` option.
