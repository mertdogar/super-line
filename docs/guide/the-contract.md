# The contract

The contract is the single source of truth, imported by both server and client. It has two axes — **role** (outer) and **direction** (inner) — and each entry's shape picks an interaction flavor.

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

Direction is encoded as **named keys**, never positional generics — you can't accidentally swap them, and there's nothing to keep in sync between the two sides.

## The five flavors

| Flavor | Contract entry | Who initiates |
| --- | --- | --- |
| **request** | `clientToServer: { input, output }` | client calls, awaits one reply |
| **event** | `serverToClient: { payload }` | server pushes to recipients it picks |
| **topic** | `serverToClient: { payload, subscribe: true }` | client subscribes; server publishes |
| **room** | server API (`srv.room(...)`) | server controls membership; broadcasts a shared event |

A `serverToClient` entry is an **event** by default; adding `subscribe: true` turns it into a **topic** the client opts into. (Topics fold into `serverToClient` so there's just one axis to learn.)

A **shared topic** is also the **cluster event bus**: the same declaration types `server.publish` (any node fans out), `server.subscribe` (in-process, cluster-wide server-side consumers with local echo), and `client.subscribe` over WS — one decl, three subscriber kinds. See [The cluster event bus](./cluster-event-bus).

## Roles

Each role is an audience with its own surface. The **effective surface** for a role is `shared ∪ roles[R]` — for both requests and events/topics. A `user` and an `agent` can have entirely different verbs:

```ts
roles: {
  user:  { clientToServer: { say:      { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) } } },
  agent: { clientToServer: { announce: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) } } },
}
```

- **Type-level**: a client created with `role: 'agent'` only sees the agent surface; `agent.say(...)` is a compile error.
- **Runtime**: the server resolves the role in `authenticate` and rejects any call outside `shared ∪ roles[role]` with `NOT_FOUND`. The role is a real security boundary, not just a typing convenience.

See [Roles & auth](./roles-auth) for how the role is resolved and verified.

## Schemas

Any [Standard Schema](https://standardschema.dev) validator works — Zod, Valibot, ArkType. The examples use Zod. The same schema both **types** the payload and **validates** it at runtime.

Next: [Requests](./requests).
