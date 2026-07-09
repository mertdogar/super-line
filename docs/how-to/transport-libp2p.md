# libp2p & WebRTC transport

Carry the contract over a **libp2p protocol stream** — which means WebSocket, **WebRTC** (direct or relayed), or WebTransport, with libp2p handling all the connection establishment and signaling for you. Provided by `@super-line/transport-libp2p`.

```bash
pnpm add @super-line/transport-libp2p libp2p
```

The big win: **you write no WebRTC signaling.** You hand the transport a libp2p node configured with the connectivity you want, and super-line rides its streams.

## Bring your own node

The transport takes a started `Libp2p` node — *you* choose its transports (`@libp2p/websockets`, `@libp2p/webrtc`, `@libp2p/webtransport`), encryption, muxer, and listen addresses. The package's only runtime deps are `@super-line/core`, `@libp2p/interface`, and `@libp2p/utils`; **`libp2p` is a peer dependency** (you already build the node).

::: tip Not the same as the libp2p adapter
This is a **separate** node from [`@super-line/adapter-libp2p`](/how-to/adapter-libp2p), which uses gossipsub for *server↔server* fan-out. Transports carry client↔server traffic; adapters carry node↔node fan-out.
:::

```ts
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { libp2pServerTransport, libp2pClientTransport } from '@super-line/transport-libp2p'

// server: a node that listens, with the protocol registered on it
const node = await createLibp2p({
  addresses: { listen: ['/ip4/0.0.0.0/tcp/9001/ws'] },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
})
createSuperLineServer(contract, { transports: [libp2pServerTransport({ node })], authenticate })

// client: a node that dials the server's multiaddr(s)
createSuperLineClient(contract, {
  transport: libp2pClientTransport({ node: clientNode, multiaddr: node.getMultiaddrs() }),
  role: 'user',
})
```

For **browser WebRTC**, the client node uses `@libp2p/webrtc` (`webRTCDirect()` for a publicly UDP-reachable server, or `webRTC()` relayed through a `circuit-relay-v2` node behind NAT); the server node advertises the matching multiaddr. libp2p performs the SDP/ICE handshake — super-line never touches it.

The realistic deployment — **servers behind NAT, browsers on the open internet** — is the [`libp2p-nat`](https://github.com/mertdogar/super-line/tree/main/examples/libp2p-nat) example: server nodes advertise *only* a `/p2p-circuit` reservation and `/webrtc` (never a dialable address), browsers reach them by WebRTC signalled through one public `circuit-relay-v2` node, with public **STUN** servers (`src/ice.ts`) so the data channel hole-punches across real NATs. Serving the page over HTTPS? Point the browser at the relay over `wss` (`RELAY_WSS_HOST`) so a plain `ws://` relay isn't blocked as mixed content.

## Auth is the first frame

libp2p has no HTTP headers or query string, so credentials ride the **first stream frame**: the client sends `{ role, params }`, and `authenticate` receives a Handshake with `transport: 'libp2p'`, `query: { role, ...params }`, and `peer: { id, addr }` — where `peer.id` is the **noise-verified PeerId**:

```ts
authenticate: (h) => {
  if (h.transport === 'libp2p') {
    // h.peer.id is cryptographically verified — allow-list it, or read h.query.token
  }
  return { role: h.query.role, ctx: {} }
}
```

## Notes

- Frames are **length-prefixed** on the stream (a raw libp2p message doesn't preserve frame boundaries under yamux) — invisible to your app.
- Star topology only: the server is a distinguished, authoritative peer; clients dial it. There is no client-to-client data path through super-line.
- Same `authenticate(handshake)`, same app-level ping/pong liveness, same reconnect model as every wire.
- See `PLAN-transports.md` for the full WebRTC-direct vs circuit-relay connectivity matrix.

Next: [Loopback (testing)](/how-to/transport-loopback) · back to [Choose a transport](/how-to/choose-a-transport).
