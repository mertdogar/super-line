# Why super-line

super-line is a typesafe WebSocket library for TypeScript. You write **one contract**; the server implements it and the client calls it with full end-to-end type inference — and **zero codegen**.

## The idea

Realtime apps usually glue together hand-maintained event-name constants, untyped payloads, and ad-hoc validation. super-line replaces all of that with a single `defineContract({...})` object that **both** sides import. From that one declaration you get:

- **Types on both ends** — the server's handlers and the client's calls are inferred from the same source, so they can't drift.
- **Runtime validation** — the same schemas that type your payloads also validate them. The server rejects malformed input automatically.
- **Five interaction flavors** over one connection — requests, events, topics, rooms, and node-to-node messaging.

## Two axes: direction and role

The contract is organized along two axes:

- **Direction** — `clientToServer` (requests) and `serverToClient` (events & topics). Each is a named key on the contract, so there are no positional generics to get backwards.
- **Role** — a `shared` base plus one block per client role (`user`, `agent`, …). A connection's role is fixed at the upgrade and decides which surface — and which `ctx` — it gets. A cross-role call is rejected with `NOT_FOUND`.

See [The contract](./the-contract) for the full model.

## How it compares

|  | super-line | Socket.IO | tRPC |
| --- | :---: | :---: | :---: |
| Typesafe contract | ✅ | ⚠️ types-only | ✅ |
| Runtime validation | ✅ | ❌ | ✅ |
| Per-role contracts | ✅ | ❌ | ❌ |
| Rooms & topics | ✅ | ⚠️ rooms only | subscriptions |
| Inter-server messaging | ✅ | ✅ | ❌ |

Socket.IO splits its types into `ClientToServerEvents` / `ServerToClientEvents` / `InterServerEvents` interfaces you wire as **positional generics** (easy to swap) with no runtime validation. super-line keeps the directional split but in **one shared object**, validates inbound automatically, and adds **per-role contracts**. See the full [comparison & FAQ](./comparison-faq).

Next: [Getting started](./getting-started).
