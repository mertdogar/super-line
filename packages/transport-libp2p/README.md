# @super-line/transport-libp2p

[libp2p](https://libp2p.io) client↔server transport for
[**super-line**](https://super-line.dogar.biz/) — carry the contract (requests · events ·
subscriptions · synced state) over a libp2p protocol stream instead of a raw WebSocket. Reach servers
behind NAT over WebRTC, dial by `PeerId` or multiaddr, and authenticate with the peer in the handshake.

```bash
pnpm add @super-line/transport-libp2p libp2p
```

> **ESM-only** — libp2p is ESM-only, so this package ships ESM only (Node 18+, `"type": "module"`).
> You **bring your own** started libp2p node (with a transport + noise + yamux); `libp2p` is a peer dependency.

## Quickstart

The server registers a protocol handler on your node; the client dials that protocol and sends its
auth as the first frame. Both default to the protocol `/super-line/1.0.0` — they MUST match.

```ts
// server
import { createSuperLineServer } from '@super-line/server'
import { libp2pServerTransport } from '@super-line/transport-libp2p'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  transports: [libp2pServerTransport({ node: serverNode })],
  authenticate(handshake) {
    // handshake.transport === 'libp2p'; the dialing peer is in handshake.peer
    const peerId = handshake.peer?.id
    return { role: 'user', ctx: { peerId } }
  },
})
```

```ts
// client
import { createSuperLineClient } from '@super-line/client'
import { libp2pClientTransport } from '@super-line/transport-libp2p'
import { api } from './contract'

const client = createSuperLineClient(api, {
  transport: libp2pClientTransport({
    node: clientNode,
    multiaddr: serverNode.getMultiaddrs(), // a Multiaddr/Multiaddr[] or a PeerId
  }),
  role: 'user',
})
```

## How it works

- **One protocol stream per connection.** The client dials `protocol`, writes its auth params as the
  first length-prefixed frame, then both sides exchange wire frames over the same stream. The server
  authenticates from that first frame before any `onConnection`.
- **The peer is the identity.** `authenticate(handshake)` receives `handshake.transport === 'libp2p'`
  plus `handshake.peer` (`{ id: <PeerId>, addr: <multiaddr> }`) and `handshake.query` (`role` + your
  params), so you can authorize by `PeerId`.
- **Bring your own node.** This transport never creates or stops a node — it `handle`s the protocol on
  the server node and `dialProtocol`s from the client node. You own listen addrs, security, muxing,
  and discovery, so you can run it over TCP, WebSockets, or **WebRTC** to reach servers behind NAT.

## Options

`libp2pServerTransport(opts)`:

| Option | Meaning |
| --- | --- |
| `node` | A started libp2p node. The transport registers a protocol handler on it (it does NOT create or stop the node). |
| `protocol` | Protocol to handle. MUST match the client. Default `/super-line/1.0.0`. |

`libp2pClientTransport(opts)`:

| Option | Meaning |
| --- | --- |
| `node` | A started libp2p node configured to dial the server's transport. |
| `multiaddr` | The server's dial target — a `Multiaddr`/`Multiaddr[]` (e.g. `serverNode.getMultiaddrs()`) or a `PeerId`. |
| `protocol` | MUST match the server. Default `/super-line/1.0.0`. |
| `dialTimeoutMs` | Dial timeout in ms. Default `10_000`. |

## Cross-NAT deployment

The realistic story — chat servers behind NAT, browsers reaching them over WebRTC via a public relay —
needs STUN (`src/ice.ts`), a circuit-relay-v2 relay, pubsub peer discovery, and `wss` so the relay
works under HTTPS. The [`libp2p-nat`](https://github.com/mertdogar/super-line/tree/main/examples/libp2p-nat)
example wires all of that up, all-docker, verified end to end.

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [transports](https://super-line.dogar.biz/how-to/choose-a-transport)
- 🧩 Example: [`libp2p-nat`](https://github.com/mertdogar/super-line/tree/main/examples/libp2p-nat)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
