# Tutorial 4 · Add auth to your app

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <a href="/tutorials/go-collaborative">3 · Go collaborative</a> → <strong>4 · Add auth to your app</strong> → <a href="/tutorials/chat-backbone">5 · Assemble a chat backbone</a></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
In <a href="/tutorials/first-collection">Tutorial 2</a> you wrote a row policy keyed on a <code>principal</code> — but you faked where it came from (<code>h.query.userId</code>). Real apps need real identity. <strong><code>@super-line/plugin-auth</code></strong> is a paired plugin that adds email/password sign-up, durable sessions, and data-driven roles to the <strong>same contract</strong> — you wire it in three touch-points and <code>principal := userId</code> becomes a logged-in user. By the end you'll watch two users sign up and each see only their own private notes.
</p>

<p class="sl-qs-meta">
  <span>~10 minutes</span>
  <span>Builds on Tutorial 2</span>
  <span>TypeScript · zero codegen</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Merge</b> <code>authContract()</code></span>
  <span class="sl-qs-pill"><b>Wire</b> <code>auth()</code></span>
  <span class="sl-qs-pill"><b>Log in</b> <code>authClient</code></span>
</p>

</div>

This lesson continues the `my-line` project — same ESM + `tsx` setup, Node 18+. If you're starting cold, the four files below are complete and copy-pasteable on their own; you'll want the [collections backend](/collections/backends) from Tutorial 2 too. We're adding a real login on top of a private, per-user collection. For the model — the connect-time seam the plugin builds on, and the two strategies — see [Choose an auth strategy](/how-to/choose-an-auth-strategy).

## 1. Install the plugin

Everything else (`core`, `server`, `client`, the transport, `zod`, `collections-memory`) you already have from Tutorials 1–2.

::: code-group

```bash [pnpm]
pnpm add @super-line/plugin-auth
```

```bash [npm]
npm install @super-line/plugin-auth
```

```bash [yarn]
yarn add @super-line/plugin-auth
```

:::

## 2. Merge the auth plugin into your contract

`authContract()` merges its half — the `guest` role, the `users`/`credentials`/`sessions` collections, and `signIn`/`signUp`/`signOut`/`whoami` — **into your contract**. So you declare only your own surface: a private `notes` collection whose rows belong to a user.

```ts [src/contract.ts]
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'

export const app = defineContract({
  roles: { user: {} }, // your roles — do NOT declare `guest`; the plugin adds it
  collections: {
    notes: {
      schema: z.object({ id: z.string(), ownerId: z.string(), text: z.string(), createdAt: z.number() }),
      key: 'id',
      references: { ownerId: 'users' }, // advisory FK into the plugin's user directory
    },
  },
  plugins: [authContract()],
})
```

The plugin's surface is merged by a plain intersection ([the plugin model](/concepts/plugins)), so `client.signUp(...)` and `client.collection('notes')` are both inferred off the one contract — no type-threading, no codegen.

## 3. Wire the server — three touch-points

The kit hands you three things: `authenticate` (verifies a credential + records a session), `identify` (sets the **principal**), and `plugin` (the request handlers plus locked-down auth collections). Your only app-specific code is the `notes` policy — the same shape as Tutorial 2, but now `principal` is a real logged-in user.

```ts [src/server.ts]
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { memoryCollections } from '@super-line/collections-memory'
import { eq } from '@super-line/core'
import { auth } from '@super-line/plugin-auth/server'
import { app } from './contract'

const server = http.createServer()
const backend = memoryCollections() // one backend serves the notes AND the auth collections

const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })

const srv = createSuperLineServer(app, {
  nodeKey: 'auth-tutorial',             // stable per replica — plugin-auth keys sessions on it
  transports: [webSocketServerTransport({ server })],
  collections: backend,
  authenticate: authKit.authenticate,   // verifies the credential and records a connection session
  identify: authKit.identify,           // principal := userId — every policy keys on the logged-in user
  plugins: [authKit.plugin],            // signIn/signUp/signOut/whoami + the locked-down auth collections
  policies: {
    notes: {
      read: (principal) => eq('ownerId', principal), // you only ever read your OWN notes
      write: (principal, op, next, prev) =>
        op === 'delete' ? prev?.ownerId === principal : next?.ownerId === principal, // …and only write your own
    },
  },
})

server.listen(3000, () => console.log('super-line server on ws://localhost:3000'))
```

`identify` is the whole story: it makes `principal` the authenticated `userId`, so the Tutorial-2 policy now fences each caller to their own rows without a single handshake param. The plugin locks its own `credentials`/`sessions` collections and opens the `users` directory — you wrote only the `notes` policy. See [Add authentication (plugin)](/how-to/plugin-auth) for everything the kit wires, and [row-level security](/collections/policies) for the policy shape.

::: tip Don't declare `guest`
`authContract()` adds the `guest` role — the pre-login connection. Declaring your own `guest` (or a `users` collection) collides at `defineContract`.
:::

## 4. Log in from the client

A role is frozen at connect, so logging in is a **reconnect**. `authClient` hides that: `signUp` connects as `guest`, mints a session, and transparently rebuilds the client as `user`.

```ts [src/client.ts]
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { authClient } from '@super-line/plugin-auth/client'
import { app } from './contract'

const url = 'ws://localhost:3000'
const connect = ({ role, params }: { role: string; params: Record<string, string> }) =>
  createSuperLineClient(app, { transport: webSocketClientTransport({ url }), role: role as 'user', params })

// Alice signs up. authClient hides the guest→user reconnect.
const alice = authClient({ authedRole: 'user', connect })
await alice.ready
await alice.signUp({ email: 'alice@example.com', password: 'correct-horse', displayName: 'Alice' })
console.log('alice →', await alice.client.whoami()) // { userId, displayName: 'Alice', roles: ['user'] }
await alice.client.collection('notes').insert({ id: 'n1', ownerId: alice.state.userId!, text: 'my private note', createdAt: Date.now() })

// Bob signs up on his own connection.
const bob = authClient({ authedRole: 'user', connect })
await bob.ready
await bob.signUp({ email: 'bob@example.com', password: 'battery-staple', displayName: 'Bob' })
await bob.client.collection('notes').insert({ id: 'n2', ownerId: bob.state.userId!, text: 'bob-only', createdAt: Date.now() })

// Each subscribes to `notes` — the read policy scopes each caller to their OWN rows.
const aliceNotes = alice.client.collection('notes').subscribe({})
const bobNotes = bob.client.collection('notes').subscribe({})
await Promise.all([aliceNotes.ready, bobNotes.ready])
console.log('alice sees →', aliceNotes.rows().map((n) => n.text)) // ['my private note']
console.log('bob sees   →', bobNotes.rows().map((n) => n.text)) // ['bob-only']

// Sign out drops back to guest.
await alice.signOut()
console.log('after signOut →', alice.state.status, await alice.client.whoami()) // 'guest' null

alice.client.close()
bob.client.close()
```

::: tip Await `ready` before trusting `state`
`authClient` restores any persisted session asynchronously, so `await alice.ready` (or check `alice.ready`) before you read `alice.state`. Login and every reconnect ride the same captured session.
:::

::: tip Not using React?
`authClient` is the framework-agnostic core. In React, [`createAuth`](/how-to/plugin-auth) wraps the identical lifecycle behind an `<AuthProvider>` + a `useAuth()` hook — `{ ready, state, client, signIn, signUp, signOut }`.
:::

## 5. Run it

Start the server, then the client in a second terminal — as in Tutorial 2:

::: code-group

```bash [Terminal 1 · server]
npm run server
```

```bash [Terminal 2 · client]
npm run client
```

:::

Two users sign up, write a note each, and read back only their own:

```ansi
alice → { userId: 'usr_…', displayName: 'Alice', roles: [ 'user' ] }
alice sees → [ 'my private note' ]
bob sees   → [ 'bob-only' ]
after signOut → guest null
```

<div class="sl-result">
  <p class="sl-result__h">Two real users, each fenced to their own rows.</p>
  <p>No handshake faking this time: <code>identify</code> made <code>principal</code> the logged-in <code>userId</code>, and the Tutorial-2 <code>read</code> policy did the rest. Alice never sees Bob's note because the server pushed <em>her</em> principal into the filter — enforced at the sync source, un-bypassable from the client.</p>
</div>

## What just happened

Each piece is one half of the plugin: the contract-time fragment merges identity onto your contract, and the runtime kit backs it.

| What you wrote | Role | What it does |
| --- | --- | --- |
| `plugins: [authContract()]` | **Contract** | Merges `guest` + `users`/`credentials`/`sessions` + `signIn`/`signUp`/`signOut`/`whoami` into your contract. |
| `auth({ … })` + `authKit.plugin` | **Server** | Email/password (scrypt), server-issued sessions, and the locked-down auth collections. |
| `identify: authKit.identify` | **Server** | `principal := userId` — real identity behind every policy. |
| `authClient({ authedRole, connect })` | **Client** | The guest↔authed lifecycle: sign up, reconnect, `whoami`, sign out. |

Try it: give Alice a second note and it joins _her_ set but never Bob's — the principal is the fence. Roles are just data on the user row, too; grant one and the same login opens a higher-privileged connection (see [Sessions, roles & API keys](/how-to/auth-sessions-roles-keys)).

## Next: assemble a chat backbone

You have real identity and a private per-user collection. The next leap merges a **second** plugin on top — channels, membership, and messages — over a model you never wrote a handler for.

<div class="sl-result">
  <p class="sl-result__h">Continue the series</p>
  <p><strong><a href="/tutorials/chat-backbone">Tutorial 5 · Assemble a chat backbone →</a></strong> — merge <code>plugin-auth</code> with <code>plugin-chat</code> and watch two users talk over a contract you never wrote a policy or handler for.</p>
</div>

### Or branch off from here

- [Add authentication (plugin)](/how-to/plugin-auth) — everything the kit wires, in one overview.
- [Sessions, roles & API keys](/how-to/auth-sessions-roles-keys) — durable sessions, roles-as-data, and `slp_` API keys.
- [JWT & sealed tokens](/how-to/auth-jwt-sealed-tokens) — server-minted bearer assertions for stateless and cross-service connect.
- [Provision an agent identity](/how-to/auth-agent-identity) — run an AI agent as an ordinary API-key user.
- [`examples/auth`](https://github.com/mertdogar/super-line/tree/main/examples/auth) — the runnable kitchen-sink: roles, API keys, JWT, sealed tokens, and hooks in one `tsx` script.
- [API reference](/reference/) — every export, option, and type.
