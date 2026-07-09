# Concepts

Understanding-oriented — the model behind the API and the reasons for it. Read these to build a mental model; reach for [How-to](/how-to/requests) when you have a task in hand.

The surface is small, but the ideas behind it — one contract for every wire pattern, a server that owns the truth, two independent seams for scaling — repay a few minutes of reading before you start wiring things together.

- [Why super-line](/concepts/why-super-line) — the assembly-tax thesis, and how one typed data bus answers it.
- [The contract](/concepts/the-contract) — the two-axis model (direction × role) and the five interaction flavors it encodes.
- [Server-authoritative](/concepts/server-authoritative) — why the server owns rooms, topics, validation, and the role boundary.
- [Transports and adapters](/concepts/transports-and-adapters) — the two independent seams: the client↔server wire versus node↔node fan-out.
- [Reconnection and delivery](/concepts/reconnection-delivery) — what survives a drop, how resubscription works, and what `await sub.ready` guarantees.
- [Plugins](/concepts/plugins) — the contract-time and runtime halves of a plugin, and how they compose into a host.
- [Comparison and FAQ](/concepts/comparison-faq) — how super-line differs from Socket.IO, tRPC, and the alternatives.
