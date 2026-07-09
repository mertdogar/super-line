# Server-authoritative by design

super-line is **server-authoritative**: the server — not the client — decides what may be said, who may say it, and what is true. That isn't a feature layered on top; it's the shape of the whole system. Three tenets hold it up, and every other guarantee in super-line falls out of them.

## Tenet 1 — the contract is the single source of truth

One `defineContract` is imported by both the server and the client. The object that *types* the client is the very same object the server *validates against* — there is no second schema to keep in sync, no codegen step that can drift. The wire's vocabulary is fixed at the contract; anything not declared there does not exist on the wire.

Because the contract is split by direction (`clientToServer` / `serverToClient`) and scoped by role (a `shared` base plus per-role blocks), the surface a given connection may touch is a pure function of the contract and the connection's role. The types the client sees and the checks the server runs come from the *same* declaration — the promise is end-to-end types **and** validate-every-message, not one or the other.

See [The contract](/concepts/the-contract) for how the two axes — role and direction — and the interaction flavors are declared.

## Tenet 2 — nothing on the wire is trusted

Every inbound message is validated against the contract schema before a handler runs. A frame that doesn't parse, carries the wrong shape, or targets a method outside the caller's surface is rejected at the edge — the handler never sees it. This holds even when a client hand-crafts a frame to bypass its own typed surface: the type system is a convenience for honest clients, but the server's runtime validation is the actual boundary.

The same principle governs persisted state. Collections are declared on the contract and **validated on every write** — including CRDT documents, whose opaque deltas are merged onto a scratch copy and snapshotted to plaintext so the result can be checked against the schema before it is committed (**validate-before-commit**). Access is **deny-by-default**: omit a policy and the operation is denied. See [Row-level security & policies](/collections/policies).

## Tenet 3 — the server owns rooms and topics

Membership and fan-out are server state, not client state. The server controls room membership and broadcasts, authorizes every subscribe, and decides who receives an event. A client can *ask* to subscribe to a topic, but the server decides whether the subscription is allowed and what flows down it. Because routing lives on the server, a client can never grant itself delivery it wasn't given — there is no client-held membership list to forge.

This is also what lets the same code run on one node or a cluster: the server is the authority locally, and a cluster adapter simply extends that authority across nodes without changing who decides. How that fan-out travels is a separate concern — see [Transports & adapters](/concepts/transports-and-adapters); the recipes are [Events & rooms](/how-to/events-rooms) and [Topics](/how-to/topics).

## Roles are a real security boundary

A connection's **role** is resolved once, when the connection is established, and fixed for its lifetime — frozen at connect. It decides which surface and which `ctx` the connection gets. The effective surface for a role is `shared ∪ roles[R]`, for requests and events/topics alike.

Two layers enforce it:

- **Type-level** — a client created with `role: 'agent'` only sees the agent surface; `agent.say(...)` is a compile error.
- **Runtime** — dispatch resolves a handler by `conn.role`, so any request or subscribe outside `shared ∪ roles[conn.role]` resolves to nothing and is rejected with **`NOT_FOUND`**.

`NOT_FOUND` — not `FORBIDDEN` — is deliberate: it doesn't reveal that the method exists for some *other* role. The role is a real security boundary, not just a typing convenience.

### The role is a claim, not a fact

The client passes its desired `role` to the client constructor, and it is surfaced to `authenticate` on the handshake. But a value the client sends is a **claim, not a fact** — the server must verify it against the credential, and may override or reject it:

```ts
authenticate: (h) => {
  const u = verify(tokenFrom(h))
  const claimed = h.query.role
  if (u.role !== claimed) throw new SuperLineError('FORBIDDEN', 'role not granted')
  return { role: u.role, ctx: { user: u } }
}
```

`authenticate` runs as the connection opens, receives the normalized handshake, and returns `{ role, ctx }` (or throws to reject — no connection opens). Because the role is fixed there, everything downstream can trust it.

The full recipe — writing `authenticate`, verifying the claim, per-role `ctx` — is in [Roles & auth](/how-to/roles-auth). First-party email/password/session auth built on this boundary is [plugin-auth](/how-to/plugin-auth).

## Authorize at the server, always

Put the three tenets together and one rule falls out: **every authorization decision lives on the server.** The contract fixes the vocabulary, validation guards the values, and role-scoped dispatch guards the verbs. A client's types are a developer-experience mirror of that authority — never a substitute for it.

::: tip Design heuristic
When you design a super-line app, ask "what is the server willing to let this role do?" and encode the answer in the contract, the role blocks, and the collection policies. The client surface falls out for free — and it can only ever be a subset of what the server already permits.
:::

Related: how state stays consistent across drops and nodes — [Reconnection & delivery](/concepts/reconnection-delivery). How the bytes physically move — [Transports & adapters](/concepts/transports-and-adapters).
