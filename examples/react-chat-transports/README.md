# react-chat-transports — the whole plugin stack, on any wire

A real Slack-shaped chat — accounts, sessions, channels, membership control, row-level security, durable
history — built almost entirely out of **`@super-line/plugin-auth`** and **`@super-line/plugin-chat`**, running
over **WebSocket**, **HTTP (SSE)** or **libp2p**. You pick the wire per tab with `?transport=`; every message
carries a badge showing which wire it was sent over.

The point: the plugins sit *above* the transport seam. Sign-in, collections, RLS, membership and live delivery
behave identically on all three wires, and no code in this example is transport-aware except one module.

## Run it

```bash
cd examples/react-chat-transports
docker compose up --build
```

- **Chat** → http://localhost:8100 — sign in, then pick a wire in the sidebar footer.
- **Control Center** → http://localhost:8101 — watch the traffic, whichever wire it took.

Two seeded demo logins (password `superline`), one click away on the login screen:

| | |
|---|---|
| `ada@example.com` | Ada |
| `grace@example.com` | Grace |

Open the same wire twice, or two wires at once:

```
http://localhost:8100/?transport=websocket
http://localhost:8100/?transport=libp2p
```

> Two tabs in the same browser share one `localStorage`, so they share one signed-in account. To watch **two
> people** talk across two wires, open the second one in a **private window** and sign in as the other demo user.

### Or locally (no Docker)

```bash
# terminal 1 — the server (WS + HTTP on :8787, libp2p /ws on :9101)
pnpm --filter @super-line/example-react-chat-transports server
# terminal 2 — the SPA (vite proxies WS/HTTP/libp2p-addr to the server)
pnpm --filter @super-line/example-react-chat-transports dev
```

Accounts, channels and messages live in `chat.db` next to the source (gitignored — delete it to reset the
workspace; in Docker it's a named volume).

## What the app actually declares

The entire contract:

```ts
export const chat = defineContract({
  roles: { user: {} },                              // the role we connect as; plugin-auth adds `guest`
  plugins: [authContract(), chatContract()],        // identity + the whole chat model
})
```

That's it — no requests, no events, no topics of its own. `plugin-auth` brings the users / credentials /
sessions / presence collections and the `guest` role; `plugin-chat` brings channels / memberships / messages
plus its request handlers and read policies. The server proves it:

```ts
srv.implement({})   // throws if any clientToServer key were unhandled — every one belongs to a plugin
```

Even "who's online" is plugin data: the sidebar subscribes to plugin-auth's `userPresence` rows, which are
derived from real connection sessions — so a tab on libp2p and a tab on HTTP see each other with no app code.

## One server, three wires

```ts
createSuperLineServer(chat, {
  nodeKey: 'react-chat-transports',                       // plugin-auth needs a stable node key
  transports: [
    webSocketServerTransport({ server }),                 // WS   — http upgrade channel
    httpServerTransport({ server }),                      // HTTP — http request channel (same server)
    libp2pServerTransport({ node }),                      // libp2p — a started libp2p node
  ],
  collections: backend,                                   // one sqlite CollectionStore for both plugins
  plugins: [authKit.plugin, chatKit.plugin, inspector()],
  authenticate: authKit.authenticate,
  identify: authKit.identify,                             // principal := userId, so RLS keys on the user
})
```

The browser picks the **client** transport in `src/lib/transport.ts` — the one file that differs between wires:

```ts
webSocketClientTransport({ url })            // WebSocket
httpClientTransport({ url })                 // HTTP / SSE  (EventSource + fetch are browser globals)
libp2pClientTransport({ node, multiaddr })   // libp2p over a browser libp2p node
```

It resolves the transport with a **top-level await** (libp2p needs an awaited node plus a fetched multiaddr),
which is what lets `lib/auth.ts` keep the ordinary module-scope `createAuth({ connect })` shape: ESM settles
this module before its importer runs.

## The dial

Choosing a wire sets `?transport=` and reloads. The access token lives in `localStorage`, so you come back
signed in, in the same channel, with the same history — over a different wire. The wire the composer used
rides along in the message's `metadata` (plugin-chat's opaque extension slot), which is what the per-message
badge renders; a wire change always breaks message grouping so the switch is visible in the feed.

*(There is no in-place hot swap: `plugin-auth` owns the connection lifecycle, and a reload is the honest,
zero-machinery way to hand it a different transport.)*

## Notes

- **libp2p wire = libp2p-over-WebSockets.** The browser builds a libp2p node (`@libp2p/websockets` + noise +
  yamux) and dials the server's `/ws` multiaddr (the server publishes its port + stable PeerId at
  `GET /libp2p-addr`, which the browser fetches and dials **directly** — not through Caddy). This is the
  reliable browser↔server libp2p path on localhost.
- **WebRTC** is a node-config swap, not a code change: give the browser and server libp2p nodes
  `@libp2p/webrtc` (`webRTCDirect()` to a public-UDP server, or relayed `webRTC()` via a `circuit-relay-v2`
  container) and the same `libp2pClientTransport`/`libp2pServerTransport` carry the chat over a WebRTC data
  channel. See the [libp2p transport guide](../../docs/how-to/transport-libp2p.md).
- Single node by design — this example showcases three *client* transports to one server. For *server↔server*
  fan-out across nodes, see the `react-chat-cluster-*` examples (that's the `Adapter`, a separate axis).
- For the same plugin stack with typing indicators and a streaming AI agent (WebSocket only), see
  [`examples/collections-chat`](../collections-chat).
