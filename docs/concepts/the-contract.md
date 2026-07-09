# The contract

The contract is the single source of truth, imported by both server and client. It has two axes — **role** (outer) and **direction** (inner) — and each entry's shape picks an interaction flavor. Understanding those two axes and the flavors they encode is most of what you need to read a super-line codebase.

```ts
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const api = defineContract({
  shared: {                        // every role inherits these
    clientToServer: { /* requests */ },
    serverToClient: { /* events + topics */ },
  },
  roles: {                         // each role sees shared ∪ its own block
    user:  { clientToServer: {…}, serverToClient: {…} },
    agent: { clientToServer: {…}, serverToClient: {…} },
  },
})
```

## Direction

Within `shared` and each role block there are two directions:

- **`clientToServer`** — requests the client may call.
- **`serverToClient`** — events and topics the client may receive.

Direction is encoded as **named keys**, never positional generics — you can't accidentally swap them, and there's nothing to keep in sync between the two sides. This is the axis that gives Socket.IO users trouble: there, the split lives in interface generics you thread by position; here it lives in the shape of the object.

## The five flavors

Each entry's shape decides how it behaves on the wire. There is no separate registry of message kinds to learn — the flavor falls out of what fields the entry has.

| Flavor | Contract entry | Who initiates |
| --- | --- | --- |
| **request** | `clientToServer: { input, output }` | client calls, awaits one reply |
| **event** | `serverToClient: { payload }` | server pushes to recipients it picks |
| **topic** | `serverToClient: { payload, subscribe: true }` | client subscribes; server publishes |
| **room** | server API (`srv.room(...)`) | server controls membership; broadcasts a shared event |

A `serverToClient` entry is an **event** by default; adding `subscribe: true` turns it into a **topic** the client opts into. (Topics fold into `serverToClient` so there's just one axis to learn.)

A **shared topic** is also the **cluster event bus**: the same declaration types `server.publish` (any node fans out), `server.subscribe` (in-process, cluster-wide server-side consumers with local echo), and `client.subscribe` over the wire — one decl, three subscriber kinds. See [The cluster event bus](/how-to/cluster-event-bus).

The recipes for each flavor live in How-to: [requests](/how-to/requests), [events & rooms](/how-to/events-rooms), and [topics](/how-to/topics). This page is only the model.

## Roles

Each role is an audience with its own surface. The **effective surface** for a role is `shared ∪ roles[R]` — for both requests and events/topics. A `user` and an `agent` can have entirely different verbs:

```ts
roles: {
  user:  { clientToServer: { say:      { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) } } },
  agent: { clientToServer: { announce: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) } } },
}
```

The role does double duty — once at the type level, once at runtime:

- **Type-level**: a client created with `role: 'agent'` only sees the agent surface; `agent.say(...)` is a compile error.
- **Runtime**: the server resolves the role in `authenticate` and rejects any call outside `shared ∪ roles[role]` with `NOT_FOUND`. The role is a real security boundary, not just a typing convenience.

## Server-authoritative enforcement

The contract is a claim about what *may* happen; the server is what makes it true. Types constrain the caller at compile time, but a hostile or buggy client can send anything. So the same contract that types a payload is also the server's runtime gate:

- Every inbound message is **validated against its schema** before a handler runs — malformed input is rejected automatically, with no hand-written checks.
- Every call is checked against the connection's **effective surface** — a cross-role call is `NOT_FOUND`, because the role was frozen at connect.

This is why the contract lives on *both* sides but is *enforced* only on one. See [Server-authoritative](/concepts/server-authoritative) for why the server owns the boundary, and [Roles & auth](/how-to/roles-auth) for how a role is resolved and verified.

## Schemas

Any [Standard Schema](https://standardschema.dev) validator works — Zod, Valibot, ArkType. The examples use Zod. The same schema both **types** the payload and **validates** it at runtime, which is what keeps the two ends from drifting: there is no second, hand-copied truth to fall out of sync.
