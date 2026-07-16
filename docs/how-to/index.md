# How-to guides

Task-oriented recipes — each solves one problem and assumes you know the basics. If you don't, start with the [Tutorials](/tutorials/first-round-trip) for a guaranteed-success build, then come back here to get a specific thing done.

## Contract & interactions

The three wire patterns declared on one contract, plus the cross-node bus.

- [Requests](/how-to/requests) — typed request/response calls with validated inputs and results.
- [Events & rooms](/how-to/events-rooms) — push server events to a client, a room, or everyone.
- [Topics](/how-to/topics) — let clients subscribe to server-owned streams and authorize each subscribe.
- [Cluster event bus](/how-to/cluster-event-bus) — `server.publish`/`server.subscribe` across nodes with local echo.

## Transports

The pluggable client↔server wire. Pick one, then wire it on both ends.

- [Choose a transport](/how-to/choose-a-transport) — decide between WebSocket, HTTP, libp2p, and loopback.
- [WebSocket transport](/how-to/transport-websocket) — the default duplex transport for server and client.
- [HTTP transport](/how-to/transport-http) — SSE plus long-poll where a socket won't do.
- [libp2p transport](/how-to/transport-libp2p) — bring your own libp2p node for peer-to-peer reach.
- [Loopback transport](/how-to/transport-loopback) — in-memory client↔server for fast tests.

## Server

Authorize, extend, and observe the server-authoritative core.

- [Roles & auth](/how-to/roles-auth) — freeze a role at connect with `authenticate(handshake)`.
- [Plugin auth](/how-to/plugin-auth) — drop in first-party sessions, API keys, and JWT via `@super-line/plugin-auth`.
- [Chat backbone](/how-to/plugin-chat) — add channels, membership control, and messages via `@super-line/plugin-chat`.
- [Middleware & lifecycle](/how-to/middleware-lifecycle) — hook connect, disconnect, and per-message handling.
- [Errors](/how-to/errors) — throw and handle `SuperLineError` across the wire.
- [Introspection & presence](/how-to/introspection-and-presence) — inspect topology, connections, and who's online.
- [Composition](/how-to/composition) — assemble a contract from surfaces with `defineSurface`/`mergeSurfaces`.
- [Building plugins](/how-to/building-plugins) — ship a paired contract-fragment plus runtime bundle.

## Client

Consume the contract from the browser or Node.

- [React](/how-to/react) — bind requests, events, topics, and collections with `createSuperLineHooks`.
- [Serialization](/how-to/serialization) — control how payloads cross the wire.

## Scaling

Fan out across nodes with a pluggable server↔server adapter.

- [Choose an adapter](/how-to/choose-an-adapter) — match a fan-out backend to your deployment.
- [Redis adapter](/how-to/adapter-redis) — pub/sub fan-out over Redis.
- [libp2p adapter](/how-to/adapter-libp2p) — broker-less gossip fan-out.
- [RabbitMQ adapter](/how-to/adapter-rabbitmq) — fan-out over a RabbitMQ broker.
- [ZeroMQ adapter](/how-to/adapter-zeromq) — fan-out over ZeroMQ sockets.

## Tooling & workflow

Develop, test, and operate super-line.

- [Control Center](/how-to/control-center) — inspect topology and live message traffic in the browser.
- [Testing](/how-to/testing) — drive contracts end to end with the loopback transport.
- [AI agents](/how-to/ai-agents) — wire agents as first-class server-authoritative writers.

Want the model behind these recipes rather than the steps? See [Concepts](/concepts/why-super-line). Every export is catalogued in the [API reference](/reference/).
