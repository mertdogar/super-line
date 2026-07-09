---
lastUpdated: false
---

# Contract entry shapes

Every entry in a [contract](/concepts/the-contract) picks an interaction flavor by its **shape**. This is the field-by-field reference; for the model and when to use each, see [The contract](/concepts/the-contract).

## The five flavors

| Flavor | Where it lives | Shape | Initiated by |
| --- | --- | --- | --- |
| **request** | `clientToServer` | `{ input, output }` | client calls, awaits one reply |
| **event** | `serverToClient` | `{ payload }` | server pushes to recipients it picks |
| **topic** | `serverToClient` | `{ payload, subscribe: true }` | client subscribes; server publishes |
| **room** | server API (`srv.room(id)`) | — (broadcasts a shared event) | server owns membership |
| **server-request** | `serverToClient` | `{ input, output }` | server calls the client, awaits a reply |

A `serverToClient` entry is an **event** by default; `subscribe: true` promotes it to a **topic**. A `serverToClient` entry with both `input` and `output` is a **server-request** (the server calls `srv.toConn(id).request(...)`; the client answers via `client.implement`).

## Field reference

```ts
// request — clientToServer
name: { input: Schema, output: Schema }

// event — serverToClient
name: { payload: Schema }

// topic — serverToClient (client opt-in)
name: { payload: Schema, subscribe: true }

// server-request — serverToClient (server calls, client replies)
name: { input: Schema, output: Schema }
```

| Field | Type | Applies to | Notes |
| --- | --- | --- | --- |
| `input` | Standard Schema | request, server-request | validated before the handler runs |
| `output` | Standard Schema | request, server-request | typed back to the caller |
| `payload` | Standard Schema | event, topic | validated on the wire |
| `subscribe` | `true` | topic | absent ⇒ event |

Any [Standard Schema](https://standardschema.dev) validator works (Zod, Valibot, ArkType). The same schema **types** and **validates** the value.

## The two axes

```ts
defineContract({
  shared: {                     // every role inherits these
    clientToServer: { /* requests */ },
    serverToClient: { /* events + topics */ },
  },
  roles: {                      // each role sees shared ∪ its own block
    user:  { clientToServer: {…}, serverToClient: {…} },
    agent: { clientToServer: {…}, serverToClient: {…} },
  },
  collections: { /* rows + CRDT docs */ }, // see /collections/
  plugins: [ /* contract fragments */ ],   // see /concepts/plugins
})
```

The effective surface for a role is `shared ∪ roles[R]`. A call outside it is rejected with `NOT_FOUND`. A **shared topic** also types the [cluster event bus](/how-to/cluster-event-bus) (`server.publish` / `server.subscribe`).

See also: [Collections](/collections/) (the `collections` block) · [API reference](/reference/).
