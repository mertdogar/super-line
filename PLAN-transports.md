# PLAN — Pluggable client↔server transports

Make the **client↔server transport** pluggable. Today the only transport is WebSocket, hard-wired
into both `packages/client` and `packages/server`. This introduces a transport seam so super-line
can run over **WebSocket**, **HTTP (SSE / long-poll)**, and the **libp2p family** (which subsumes
WebRTC-direct, relayed WebRTC, and WebTransport) — under the *same* contract, frame protocol, and
server-authoritative model. The server-to-server `Adapter` (`packages/core/src/adapter.ts`) is a
**separate concern and is untouched** by this work.

> Status: **DESIGN — settled in a grilling session and grounded by a multi-agent research pass on
> js-libp2p connectivity / stream API / WebRTC signaling.** Rationale is captured below so we don't
> relitigate. Build is incremental (extraction first), not a big-bang rewrite.

---

## 1. Goal & framing

- One pluggable **client↔server transport** seam, mirroring the *philosophy* (not the shape) of the
  `Adapter`: a tiny interface, an in-memory loopback default for tests, one package per implementation.
- **Server-authority is preserved byte-for-byte.** Star topology only — one distinguished
  authoritative server peer; clients dial it. No client-to-client data path ever flows through
  super-line, even over WebRTC/libp2p (which *can* mesh — we deliberately don't).
- The transport moves **opaque encoded bytes** over a **logical connection**. The serializer and the
  frame protocol (`req/res/evt/pub/sub/sreq/...`) stay in core. The transport **hides all physical
  churn** (SSE's dual channel, long-poll's request sequence, WebRTC signaling, physical reconnects);
  the core only ever sees a logical connection and its *logical* death.
- "I want all of them" → full surface is the goal, but built **incrementally** and designed against
  the *hardest* transport so the interface doesn't leak.

## 2. Why `Adapter` is NOT reused as the transport (settled)

`Adapter` and the transport both shuttle `string | Uint8Array`, but they solve different problems and
forcing one into the other hurts:

| | `Adapter` (node↔node) | client↔server transport |
|---|---|---|
| Topology | broadcast: 1 publish → N subscribers | unicast: server ↔ one client |
| Symmetry | symmetric peers (everyone pub+sub) | asymmetric: server **listens/accepts**, client **dials** |
| Unit | a **channel** (string key) | a **connection** (identity, role, auth, lifecycle) |
| Lifecycle | none — channels are eternal | accept, close, **close code**, backpressure, liveness |
| Handshake | none | must carry headers/query/peerId into `authenticate` |
| Delivery | fire-and-forget, no ordering | ordered, per-conn buffer/drain signal |

`Adapter` has no `accept`, no per-conn `close(code)`, no handshake — exactly what the transport layer
exists to provide. What we **borrow** from it is the *packaging*: `@super-line/transport-*`, an
in-memory loopback default, opaque-bytes payloads. Note: `@super-line/adapter-libp2p` exists but is a
**server-to-server** fan-out adapter — using libp2p as a *client↔server transport* is a different job
with the same library, on a **separate libp2p node**.

## 3. libp2p research verdict (grounds §4 / §5)

- **libp2p hands you WebRTC signaling for free** — call `dialProtocol(multiaddr, protocol)`; you never
  touch SDP/ICE. So a **bespoke HTTP signaling route is the wrong call** for the libp2p path.
  - `webrtc-direct`: **zero signaling, zero relay** — browser synthesizes the server's SDP answer from
    a `certhash` in the multiaddr. Needs a **public UDP port** (breaks on TCP/443-only PaaS).
  - `webrtc` (relayed): SDP brokered through a `circuit-relay-v2` node (for NAT'd servers). Relay
    infra, but still no signaling *code* we write.
- **libp2p is a transport *family* behind one stream API** — the same `node.handle(protocol)` /
  `dialProtocol` + a `send(bytes)`/`'message'` bridge covers **WebSocket, WebTransport, WebRTC-direct,
  and relayed WebRTC**. So WebRTC **collapses into one `transport-libp2p` package**, not a standalone
  transport (standalone WebRTC only avoids the libp2p client bundle — and resurrects the signaling
  problem it removes).
- **Stream API maps ~1:1** (libp2p v3 `Stream` is an `EventTarget`): `stream.send(bytes)` /
  `'message'` event (`evt.data.subarray()`) / `'close'` / `stream.close()` (graceful) vs
  `stream.abort()` (hard). No numeric `bufferedAmount` (boolean `send()===false` + `'drain'`); no close
  *codes* (synthesize). Handler is `(stream, connection)` in v3.
- **Auth:** no HTTP headers/query — context is the **noise-verified `connection.remotePeer` (PeerId) +
  a first-frame auth payload** on the stream. Validates the §4 `Handshake` + transport-internal in-band
  auth design.
- Deps (pin exact — ESM-only, fits): `libp2p@3.x`, `@libp2p/websockets`, `@chainsafe/libp2p-noise`,
  `@chainsafe/libp2p-yamux`, `@libp2p/webrtc` (exports `webRTC()` + `webRTCDirect()`),
  `@libp2p/circuit-relay-v2` (relayed only), `@libp2p/utils` (`lpStream`/`byteStream` if framing needed).

## 4. The seam — interfaces (live in `@super-line/core`)

Every transport package depends on `core`; `client`/`server` depend only on `core`, never on a
specific transport.

```ts
interface RawConn {
  send(bytes: string | Uint8Array): void
  readonly writable: boolean                       // Q7 — portable; WS derives from bufferedAmount
  onMessage(cb: (bytes: Uint8Array) => void): void
  onClose(cb: (code: number, reason?: string) => void): void
  onDrain(cb: () => void): void                    // Q7
  close(code?: number, reason?: string): void      // graceful — Q5
  terminate(): void                                // hard (reaping) — Q5
}

interface Handshake {
  transport: string                                // 'websocket' | 'sse' | 'libp2p' | ...
  headers: Record<string, string | string[]>       // ws/sse fill; libp2p/webrtc sparse
  query: Record<string, string>                     // role + params land here, uniformly
  peer?: { id: string; addr?: string }              // libp2p/webrtc identity
  raw: unknown                                       // IncomingMessage for ws, signal payload, ...
}

type AuthOutcome = { role: string; ctx: unknown }   // (reject = throw, transport rejects natively)

interface ServerTransport {                          // Q8 — transport drives auth, core decides
  start(hooks: {
    authenticate: (h: Handshake) => Promise<AuthOutcome>  // core owns the decision (opts.authenticate)
    onConnection: (raw: RawConn, auth: AuthOutcome) => void // ONLY fires for accepted conns
  }): void | Promise<void>
  stop(): void | Promise<void>
}

interface ClientTransport {
  connect(handshakeParams: Record<string, string>, hooks: {
    onOpen(): void; onMessage(b: Uint8Array): void; onClose(code: number): void; onDrain(): void
  }): RawConn                                         // transport encodes params in its native dial
}
```

`authenticate(handshake)` replaces `authenticate(req)`. Each transport calls `hooks.authenticate` at
its native moment and rejects in its native idiom — WS at the HTTP upgrade (**401 without upgrading**),
SSE on the GET (HTTP status), libp2p after the first auth frame (`stream.abort()`). The core therefore
**never holds an unauthenticated `Conn`** (the invariant below holds by construction).

## 5. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| Q1 | scope | **All transports are the goal, built incrementally**; interface designed against the hardest (SSE + libp2p), not WS |
| Q2 | seam | Transport moves **opaque bytes** over a **logical connection**; transport **hides all physical churn**; serializer + frames stay in core |
| Q3 | auth context | **`authenticate(handshake)`** replaces `authenticate(req)` — normalized `Handshake` with a `raw` escape hatch (**breaking**) |
| Q4 | auth timing | **No `Conn` until authed.** In-band auth (libp2p/webrtc first-frame) happens **inside the transport**; core invariant untouched. No first-class unauthenticated connections |
| Q5 | liveness | **App-level `{t:'ping'}`/`{t:'pong'}` frames** owned by core; client answers; native WS ping dropped. Interface carries `close()` (graceful) + `terminate()` (hard). `presence.beat` (node liveness) unchanged |
| Q6 | topology / signaling | **Star only, server sole authority, no client-to-client.** **No bespoke signaling** — libp2p owns WebRTC SDP/ICE (`webrtc-direct` zero-infra-but-public-UDP; relayed via `circuit-relay-v2`) |
| Q7 | backpressure | Portable **`writable` + `onDrain`**; byte-threshold `maxBufferedBytes` demoted to a **WS-transport option** |
| Q8 | server attach + auth driver | Replace `opts.server` with `opts.transports`. **Transport drives auth, core decides** (`start({ authenticate, onConnection })`). **No `url`/`server` sugar** — `transport(s)` is the only API both sides |
| Q9 | reconnect | **No session resume.** Logical reconnect re-auths → new `Conn`, client re-subscribes + re-sends unsent (exactly as today). Missed events are an app-layer concern |
| Q10 | inspector | **Access channel WS-only** (WS transport owns the `superline.inspector.v1` subprotocol + reserved `INSPECTOR_ROLE`). Inspector **`msg.*` events stay transport-agnostic in core** — libp2p/SSE traffic is still observable |
| Q11 | tests | **Ship a `transport-loopback`**; core-protocol tests → loopback (socket-free, de-flaked), WS-specific tests → real WS in `transport-websocket`. Acceptance: all 138 green |
| Q12 | packages | Interfaces in `core`; **`transport-http` covers both SSE and long-poll** (`mode` option, shared POST + session machinery); WebRTC folds into `transport-libp2p` |

## 6. Package taxonomy

| Package | Covers | Notes |
|---|---|---|
| `@super-line/core` | the interfaces | `ServerTransport`/`ClientTransport`/`RawConn`/`Handshake`/`AuthOutcome` |
| `@super-line/transport-websocket` | raw WS | extract existing; **owns the inspector subprotocol** (Q10) |
| `@super-line/transport-http` | SSE + long-poll | `mode: 'sse' \| 'longpoll'`; shares POST upbound + session/logical-conn machinery |
| `@super-line/transport-libp2p` | libp2p family: ws / webrtc-direct / relayed-webrtc / webtransport | **subsumes WebRTC**; **separate node** from `adapter-libp2p` |
| `@super-line/transport-loopback` | in-memory | test substrate + interface proof; also useful for *users'* unit tests |

## 7. What moves vs stays (the rewrite)

**Leaves `packages/server/src/index.ts` → `transport-websocket`:** `WebSocketServer`, the `'upgrade'`
handler, `handleUpgrade`, `isInspectorRequest`, `toWire`, `ws.ping()`, `bufferedAmount`, `opts.path`,
`backpressure.maxBufferedBytes`.

**Stays in core (already frame-shaped):** `onMessage` frame dispatch, `handleReq`/`handleSub`,
middleware, rooms/topics, adapter fan-out, presence, the server→client request bus, the heartbeat loop
(now sending `{t:'ping'}` *frames*). Fed by `rawConn.onMessage(bytes)` instead of `ws.on('message')`.

**`Conn` (breaking for tests):** stops wrapping `ws`; public `conn.ws` field **removed**;
`conn.ws.terminate()` → `conn.terminate()` / `conn.close()` across the suite.

**Client (`packages/client/src/index.ts`):** `connect()`, `ws.onopen/onmessage/onclose`,
`ws.readyState`, `ws.send`, `buildUrl` move behind `ClientTransport`. Core keeps the request map,
event/topic listeners, topic re-subscribe, and reconnect backoff — now reacting to the transport's
`onOpen`/`onClose` and the **logical** connection (physical churn never reaches it).

## 8. Breaking changes (pre-1.0, broken cleanly)

- `authenticate(req: IncomingMessage)` → `authenticate(h: Handshake)`.
- `opts.server` / client `opts.url` (+ `opts.WebSocket`, `opts.path`, `opts.backpressure`) removed in
  favor of `opts.transports` / `opts.transport`; WS-specific options move into `webSocketTransport({...})`.
- `conn.ws` removed → `conn.terminate()` / `conn.close()`.

## 9. Delivery plan (incremental)

1. **Extraction + loopback (pure refactor).** Define the §4 interfaces in `core`; move WS into
   `transport-websocket`; ship `transport-loopback`. Rewire `Conn` onto `RawConn`; convert heartbeat
   to ping/pong frames; move auth to `Handshake`. **Acceptance: all 138 green** — core tests on
   loopback, WS-specific tests on real WS. *Two transports passing one test battery is the proof the
   seam isn't WS-shaped.*
2. **`transport-http`** (SSE + long-poll). Exercises the hardest edges — half-duplex, one logical
   session over many short requests, POST upbound channel, http-route mounting.
3. **`transport-libp2p`.** Start with `webRTCDirect()` to a public-UDP Node server (least infra);
   add relayed `webrtc` + a `circuit-relay-v2` node and `wss`/WebTransport per-multiaddr config after.

## 10. Open empirical items (transport-internal; verify when building)

- **Frame-boundary preservation over yamux** — the native libp2p `'message'` event may not preserve
  frame boundaries; if not, add length-prefix framing (`lpStream`/`byteStream`) **inside**
  `transport-libp2p` (invisible to core).
- **`webrtc-direct` needs a public UDP port** — breaks on TCP/443-only PaaS; fall back to `wss` or
  relayed `webrtc` there.
- **`webrtc-direct` SDP munging** is spec-technically-disallowed but browser-tolerated; interop-test
  target browsers (Safari historically lagged) before production reliance.
- **Browser bundle size** — `@libp2p/webrtc` is materially heavier than the raw-WS client; keep the
  libp2p transport an optional package, never a core dependency; measure vs today's WS-only bundle.
