# Hand a connection its credentials — `env`

`env` is a **typed, per-connection state bag the server vends to the client**: the server fills it (from your
business logic), super-line pushes it to that connection and keeps it live, and the client reads it. It's the
visibility-mirror of `conn.data` — *`data` is server-side scratch; `env` is the same, but the client sees it.*

The motivating case: an **AI agent** shares a channel with a human and needs real credentials — an
`omma.ai` API key, a `projectId` — to call other services *for* the human. The server knows which creds each
connection should hold; `env` is how it hands them over and rotates them mid-conversation. super-line is a pure
**courier** — it validates and delivers the payload, but never interprets or acts on it (no impersonation, no
"on-behalf-of"). See [ADR-0012](https://github.com/mertdogar/super-line/blob/main/docs/adr/0012-connection-env-is-server-vended-client-visible-state.md).

::: warning env holds secrets
`env` is **never persisted** — it lives only in memory on the live connection and is re-seeded on reconnect.
It's for your agent's **runtime** to read and wire into its tool calls; **never expose it to an LLM** (keep raw
keys out of prompts and traces). In the Control Center it is **masked by default** (see below).
:::

## 1 · Declare the shape on the contract

`env` is an optional per-role schema, a sibling of `data`. Types flow end-to-end (`EnvOf<C, R>`):

```ts
import { defineContract } from '@super-line/core'
import { z } from 'zod'

const app = defineContract({
  roles: {
    agent: {
      env: z.object({ projectId: z.string(), ommaApiKey: z.string() }),
      // …clientToServer / serverToClient
    },
  },
})
```

A role with no `env` → `client.env.current` is `null`.

## 2 · Seed it at connect

`authenticate` returns the initial `env` alongside `role` and `ctx` — one connect-time call yields both the
frozen, server-only **identity** (`ctx`) and the client-visible **env**:

```ts
createSuperLineServer(app, {
  authenticate: async (handshake) => {
    const { role, ctx } = await verify(handshake)      // your identity resolution
    const env = ctx.userId ? await computeEnv(ctx.userId) : undefined  // your business logic (undefined = none)
    return { role, ctx, env }
  },
})
```

Because `authenticate` is awaited before the connection is ready, the client always has `env` on connect (no
race) — and it re-runs on every reconnect, so nothing is cached across a drop.

**With [`@super-line/plugin-auth`](/how-to/plugin-auth)** the kit owns `authenticate`, so pass a `resolveEnv`
keyed on the resolved identity:

```ts
const authKit = auth({
  contract: app,
  collections: backend,
  resolveEnv: async (ctx) => (ctx.userId ? await computeEnv(ctx.userId) : undefined),
})
```

## 3 · Read it on the client

`client.env` is a reactive handle. `await .ready` before reading (it resolves after the first push), then use
`.current`; `.subscribe` fires on every update.

```ts
await client.env.ready
const { ommaApiKey, projectId } = client.env.current!   // typed EnvOf<C, R>

// give an AI SDK agent hands whose tool implementations use the creds — the model never sees them:
const tools = chatAgentTools(client, {
  bookMeeting: (args) => callOmma({ apiKey: client.env.current!.ommaApiKey, ...args }),
})

client.env.subscribe((env) => refreshOutboundClients(env))   // react to rotation / re-scope, live
```

In React: `const env = useEnv()` (from `@super-line/react`) — `null` until the first push, re-renders on updates.

## 4 · Update it live

Rotate a key or re-scope the connection mid-conversation — no reconnect:

```ts
conn.setEnv({ projectId, ommaApiKey: rotated })          // a live conn (node-local; validated vs the role schema)
srv.toUser(botUserId).setEnv({ projectId, ommaApiKey })  // all of a user's connections (cluster-wide)
authKit.pushEnv(botUserId, { projectId, ommaApiKey })    // plugin-auth sugar over toUser().setEnv
```

## 5 · Inspect it (masked) in the Control Center

`env` surfaces in the connection detail and as an **Env** live-feed event — but because it holds credentials it
is **masked by default** (the opposite of `ctx`/`data`). The *shape* is always shown; values render as `•••`
unless you allow-list the safe keys:

```ts
plugins: [inspector({ revealEnvKeys: ['projectId'] })]   // projectId shown; ommaApiKey stays •••
```

## How `env` differs from `ctx` and `data`

| | `conn.ctx` | `conn.data` | `conn.env` |
|---|---|---|---|
| set by | `authenticate`, once (frozen) | server code (mutable) | `authenticate` + `setEnv` (mutable) |
| visible to the client | no | no | **yes** |
| job | identity — the authz input | server-side scratch | creds/config for the client |

`ctx` and `env` are produced by the same `authenticate` call but are never the same bag: `ctx` is the frozen,
server-only identity your policies authorize against; `env` is the mutable, client-visible payload.
