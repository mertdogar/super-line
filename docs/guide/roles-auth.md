# Roles & auth

A connection's **role** is resolved once, when the connection is established, and fixed for its lifetime. It decides which surface and which `ctx` the connection gets — and it's enforced server-side.

## authenticate returns `{ role, ctx }`

`authenticate` runs as the connection opens. It receives the **handshake** (`{ transport, headers, query, peer?, raw }`) — read query params via `h.query.X` and headers via `h.headers`, regardless of which transport carried the connection. Return `{ role, ctx }`, or `throw` to reject (no connection is opened):

```ts
import { webSocketServerTransport } from '@super-line/transport-websocket'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate: async (h) => {
    const token = h.query.token
    const user = await verifyJwt(token)   // throw -> rejected
    return { role: 'user' as const, ctx: { user } }
  },
})
```

`@super-line/transport-websocket` provides the WebSocket transport. Other transports (HTTP/SSE, libp2p) are available — see the Transports guide; they all hand `authenticate` the same `Handshake`.

Return `role` as a **literal** (`'user' as const`) so it's inferred as a role key rather than widening to `string`.

## Per-role ctx

Different roles usually carry different identity data. Return a discriminated `{ role, ctx }` and each handler block sees the right `ctx`:

```ts
authenticate: (h) => {
  const u = verify(h)
  return u.role === 'admin'
    ? { role: 'admin' as const, ctx: { adminId: u.id } }
    : { role: 'user' as const,  ctx: { userId: u.id } }
}

srv.implement({
  admin: { /* ctx is { adminId: string } */ },
  user:  { /* ctx is { userId: string } */ },
})
```

In a `shared` handler, `ctx` is the union of all roles' ctx — use common fields, or branch on `conn.role`.

## The role is a claim — verify it

The client passes its `role` to `createSuperLineClient`; it's surfaced to `authenticate` on the handshake (`h.query.role` for the WS/HTTP transports) so `authenticate` can read it. **It's a claim, not a fact** — always verify it against the credential:

```ts
authenticate: (h) => {
  const u = verify(tokenFrom(h))
  const claimed = h.query.role
  if (u.role !== claimed) throw new SuperLineError('FORBIDDEN', 'role not granted')
  return { role: u.role, ctx: { user: u } }
}
```

## Enforcement: NOT_FOUND

Dispatch resolves a handler by `conn.role`, so a request or subscribe outside `shared ∪ roles[conn.role]` resolves to nothing and is rejected with **`NOT_FOUND`** — even if a client hand-crafts the frame to bypass its typed surface. `NOT_FOUND` (rather than `FORBIDDEN`) is deliberate: it doesn't reveal that the method exists for some *other* role.

## AI agents as a role

Roles shine when a server serves **both humans and AI agents**. Give each its own verbs and topics:

```ts
roles: {
  user:  { clientToServer: { say: {…} } },
  agent: {
    clientToServer: { reportResult: {…} },
    serverToClient: { taskAssigned: { payload: z.object({ taskId: z.string(), prompt: z.string() }), subscribe: true } },
  },
}
```

- An agent client (`role: 'agent'`) sees only the agent surface — it can `reportResult` and `subscribe('taskAssigned')`, but `agent.say(...)` won't compile.
- A user can't call agent-only methods (compile error, and `NOT_FOUND` at runtime).
- Each gets its own `ctx` (`{ userId }` vs `{ agentId, capabilities }`).

The [chat example](https://github.com/mertdogar/super-line/tree/main/examples/chat) shows a human and an AI agent sharing one room.

Next: [Middleware & lifecycle](./middleware-lifecycle).
