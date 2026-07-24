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

Three services come up: the chat node, Caddy, and a **`verifier`** that exists only to check JWTs (below).

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
# terminal 3 — the JWT verifier on :8788 (optional; only the Verify button needs it)
pnpm --filter @super-line/example-react-chat-transports verifier
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

## Bearer assertions (JWT / JWE)

The key icon beside the dial opens the **bearer token** panel. It demonstrates plugin-auth's two kinds of
assertion, which differ in exactly one way that changes everything: **who can read the payload**.

**Getting a signed assertion.** *Get a token* posts to `/signed-token` with the access token you already
hold; the server verifies it and mints a short-lived HS256 JWS — there is no client-facing mint (ADR-0015).
The panel shows its claims and counts down its life. The server enables all of this with one option:

```ts
auth({ …, jwt: { secret: JWT_SECRET, ttlMs: 2 * 60_000 } })   // 2 minutes here; the default is 15
```

**Verifying, somewhere else.** *Verify elsewhere* calls `GET /api/verify` on the `verifier` service. Look at
what [`src/verifier.ts`](./src/verifier.ts) imports: `node:http` and `jose`. No super-line, no contract, no
collections — and in `docker-compose.yml` it has no `chat-db` volume and no route to the database. It shares
exactly **one** thing with the chat node, the signing secret, and that is enough to trust the caller. That is
the difference between an assertion and an access token: an access token is a lookup key, so whoever validates
it needs your database.

**Exchanging it for a sealed assertion.** *Exchange for a sealed token* posts the signed token to
`/sealed-handoff` on the chat node, which mints a **JWE** — and the panel then reports that it cannot read
what it just received. That is the point. A sealed assertion is server-minted, like the signed one (neither
has a client-facing mint), carries a public `claims` bag and an encrypted `sealed` one, and lets you route a
secret *through* a browser that can never see it. Here the endpoint seals a stand-in upstream API key.

**Connecting.** The links at the bottom of each section open the app on a wire of your choice carrying that
token; both kinds connect with `params: { jwt }` instead of a stored access token, and a yellow banner marks
the tab. The banners differ, because the tabs genuinely know different things: a signed tab decoded its own
claims and runs an expiry countdown; a sealed tab shows only what the server chose to vend it as
[`env`](https://super-line.dogar.biz/how-to/connection-env) — one line in `src/server.ts`:

```ts
resolveEnv: (ctx) => (typeof ctx.claims?.workspace === 'string' ? { workspace: ctx.claims.workspace } : undefined)
```

`ctx.sealed` never appears there, so the encrypted half stays on the server while the handler that needs it
reads it straight off the connection context.

Because none of this touches `localStorage`, a bearer tab is the one way to hold **two independent
connections in one browser** — though both are the same user, so two *people* still means a private window.

A few behaviours worth watching for, because they are properties of JWTs rather than quirks of this app:

- **A JWT is checked only at connect.** Let the banner's countdown run out and the tab keeps working — it was
  authorized once. What expired is your ability to start a *new* connection; hit **Verify elsewhere** after
  expiry and the verifier rejects the very token the live connection is still running on.
- **A rejected token does not fail the connect.** `authenticate` resolves an expired or forged JWT to `guest`
  and the server accepts the connection at that role. So the app confirms with a `whoami()` before trusting it
  — the same confirm-then-trust step plugin-auth's own client does when restoring a stored token.
- **Revocation is the trade-off.** `authKit.revoke(userId)` flushes access tokens and disconnects, but an
  outstanding JWT is in no table to revoke. Short TTLs are the mitigation; `users.deactivate()` is the
  emergency stop, and it works because connect performs one user read. The
  [`auth`](../auth) CLI example walks through exactly this.

> The handoff link carries a bearer credential in a URL, which is fine for a demo and wrong in production —
> it lands in history and referrers. The receiving tab strips it from the address bar on arrival; a real
> handoff uses an `Authorization` header or a one-time exchange code. The panel's **Copy token** button and
> the login screen's *Have a bearer token?* box are the paste-based path.

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
