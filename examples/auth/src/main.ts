import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { jwtVerify } from 'jose'
import { z } from 'zod'
import { defineContract, eq } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { memoryCollections } from '@super-line/collections-memory'
import { webSocketClientTransport, webSocketServerTransport } from '@super-line/transport-websocket'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { authClient } from '@super-line/plugin-auth/client'

// Proper authentication as a paired plugin. `authContract()` adds — to the contract merged on BOTH ends —
// the `guest` role, the `users`/`credentials`/`sessions` collections, and signIn/signUp/signOut/whoami. So the
// app declares only its OWN surface: a private `notes` collection and an admin-only `stats` request.
const app = defineContract({
  roles: {
    // A user acts through the notes collection + the shared whoami/signOut. `useUpstream` exists to prove a
    // point about sealed assertions: it reads a secret the CLIENT is carrying but cannot read, and returns
    // only a fingerprint of it. `env` is the client-visible slice — here, the assertion's public claims.
    user: {
      env: z.object({ workspace: z.string().optional() }),
      clientToServer: {
        useUpstream: {
          input: z.void(),
          output: z.object({ workspace: z.string().nullable(), upstreamKeyTail: z.string().nullable() }),
        },
      },
    },
    admin: { clientToServer: { stats: { input: z.void(), output: z.object({ users: z.number() }) } } },
  },
  collections: {
    notes: {
      schema: z.object({ id: z.string(), ownerId: z.string(), text: z.string(), createdAt: z.number() }),
      key: 'id',
      references: { ownerId: 'users' }, // advisory FK into the auth plugin's user directory
    },
  },
  plugins: [authContract()],
})

// The JWT signing secret. In a real deployment it is deployment config, shared with whichever other
// services need to verify a token — and with nothing else.
const JWT_SECRET = 'dev-only-insecure-shared-secret'

async function main(): Promise<void> {
  const server = http.createServer()
  const backend = memoryCollections()
  // The SAME backend is handed to both the auth kit (so `authenticate` can read sessions/users) and the server.
  // `jwt` turns on both halves of the JWT feature: the `getToken` request, and `params: { jwt }` at connect.
  const authKit = auth({
    contract: app,
    collections: backend,
    defaultRoles: ['user'],
    jwt: { secret: JWT_SECRET },
    // The public half of an assertion is NOT client-visible by default. This one line vends it as `env`
    // (ADR-0012) — the sealed half stays server-side because nothing here ever puts it on the wire.
    resolveEnv: (ctx) => ({ workspace: (ctx.claims?.workspace as string | undefined) ?? undefined }),
  })

  const srv = createSuperLineServer(app, {
    nodeKey: 'auth-example',
    transports: [webSocketServerTransport({ server })],
    collections: backend,
    authenticate: authKit.authenticate, // verifies an access token and records the connection session
    identify: authKit.identify, // principal := userId, so row policies key on the logged-in user
    // The plugin locks credentials/sessions and opens the users directory; the app adds only its notes policy.
    policies: {
      notes: {
        read: (principal) => eq('ownerId', principal), // you only ever read your OWN notes
        write: (principal, op, next, prev) =>
          op === 'delete' ? prev?.ownerId === principal : next?.ownerId === principal, // …and only write your own
      },
    },
    plugins: [authKit.plugin],
  })
  // signIn/signUp/signOut/whoami are plugin-handled → subtracted; the empty user/guest/shared blocks are optional.
  srv.implement({
    admin: { stats: async () => ({ users: (await srv.collection('users').snapshot()).length }) },
    user: {
      // ctx.sealed is server-minted and arrives decrypted. Returning a 4-char tail is the whole point: the
      // client handed us the key without ever being able to read it.
      useUpstream: async (_input, ctx) => {
        const key = ctx.sealed?.upstreamKey as string | undefined
        return {
          workspace: (ctx.claims?.workspace as string | undefined) ?? null,
          upstreamKeyTail: key ? `…${key.slice(-4)}` : null,
        }
      },
    },
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const transport = () => webSocketClientTransport({ url })
  // The one concession for the guest↔authed swap: connect is called first as 'guest', then 'user'.
  const connect = ({ role, params }: { role: string; params: Record<string, string> }) =>
    createSuperLineClient(app, { transport: transport(), role: role as 'user', params })

  // ── Alice signs up. authClient hides super-line's guest→user reconnect: signUp connects as guest, mints a
  //    session, and transparently rebuilds the client as `user`. ──
  console.log('— Alice signs up —')
  const alice = authClient({ authedRole: 'user', connect })
  await alice.ready
  await alice.signUp({ email: 'alice@example.com', password: 'correct-horse', displayName: 'Alice' })
  console.log('  whoami →', await alice.client.whoami()) // { userId, displayName: 'Alice', roles: ['user'] }
  const aliceId = alice.state.userId!
  await alice.client.collection('notes').insert({ id: 'n1', ownerId: aliceId, text: 'my api keys are…', createdAt: Date.now() })

  // ── Bob signs up. His notes read policy keys on HIS principal, so Alice's note is invisible to him. ──
  console.log('\n— Bob signs up —')
  const bob = authClient({ authedRole: 'user', connect })
  await bob.ready
  await bob.signUp({ email: 'bob@example.com', password: 'battery-staple', displayName: 'Bob' })
  const bobId = bob.state.userId!
  await bob.client.collection('notes').insert({ id: 'n2', ownerId: bobId, text: 'lunch ideas', createdAt: Date.now() })

  const aliceNotes = alice.client.collection('notes').subscribe({})
  const bobNotes = bob.client.collection('notes').subscribe({})
  await Promise.all([aliceNotes.ready, bobNotes.ready])
  console.log('  Alice sees →', aliceNotes.rows().map((r) => r.text)) // ['my api keys are…'] — RLS: only her own
  console.log('  Bob sees   →', bobNotes.rows().map((r) => r.text)) // ['lunch ideas']

  // The user directory is public — both see both.
  const dir = alice.client.collection('users').subscribe({})
  await dir.ready
  console.log('  directory  →', dir.rows().map((r) => r.displayName).sort()) // ['Alice', 'Bob']

  // ── Roles are just data. Grant Alice `admin` by co-writing her user row; her access token then opens an
  //    admin connection (authenticate validates the requested role against her granted roles). ──
  console.log('\n— Alice is promoted to admin —')
  await srv.collection('users').update({ id: aliceId, displayName: 'Alice', roles: ['user', 'admin'], createdAt: Date.now() })
  const guest = createSuperLineClient(app, { transport: transport(), role: 'guest' })
  const { token } = await guest.signIn({ email: 'alice@example.com', password: 'correct-horse' }) // fresh access token
  guest.close()
  const adminAlice = createSuperLineClient(app, { transport: transport(), role: 'admin', params: { token } })
  console.log('  admin stats →', await adminAlice.stats()) // { users: 2 } — the same token now authorizes 'admin'
  adminAlice.close()

  // ── A bearer assertion is a CLAIM, not a stored credential. `getToken()` mints one from the live
  //    session; nothing about it is written down, so verifying it needs the secret and nothing else. ──
  console.log('\n— Bob mints a signed assertion —')
  const { jwt } = await bob.client.getToken({ claims: { workspace: 'acme' } })

  // 1 · Another backend verifies it offline. No super-line, no database, no call home — just the secret.
  //     Note `claims` is right there in the payload: a signed assertion hides NOTHING from its holder, and
  //     because `getToken` is a client request, Bob wrote that bag himself. Never authorize on it.
  const { payload } = await jwtVerify(jwt, new TextEncoder().encode(JWT_SECRET))
  console.log('  verified offline →', { sub: payload.sub, roles: payload.roles, claims: payload.claims })

  // 2 · Or connect with it. No access-token lookup — but the connection is still a first-class one, and
  //     `authenticate` records a session row for it, stamped with how it authenticated.
  const viaJwt = createSuperLineClient(app, { transport: transport(), role: 'user', params: { jwt } })
  console.log('  whoami over jwt →', await viaJwt.whoami())
  const jwtSession = (await srv.collection('sessions').snapshot()).find((s) => s.authMethod === 'jwt')
  console.log('  session row →', { authMethod: jwtSession?.authMethod, userId: jwtSession?.userId })
  viaJwt.close()

  // ── A SEALED assertion is the other kind: a JWE. Same handshake param, but the payload is encrypted, so
  //    its own holder cannot read it — which is what lets you route a secret THROUGH a client. Only the
  //    server mints one; there is deliberately no client-facing equivalent of getToken for it. ──
  console.log('\n— The server mints a sealed assertion for Bob —')
  const { token: sealedToken } = await authKit.tokens.mintSealed(bobId, {
    claims: { workspace: 'acme' }, // public half — safe to show Bob
    sealed: { upstreamKey: 'sk-live-7f3a-9c21' }, // encrypted half — Bob carries it, never sees it
  })
  console.log('  parts →', sealedToken.split('.').length, '(a JWE has 5; a JWS has 3)')
  console.log('  the secret is not in the token →', !sealedToken.includes('sk-live'))
  // Bob holds the token, and the shared secret is not even what decrypts it — the CEK is derived separately.
  const bobCanRead = await jwtVerify(sealedToken, new TextEncoder().encode(JWT_SECRET)).then(
    () => true,
    () => false,
  )
  console.log('  Bob can decode it →', bobCanRead) // false

  // Connect with it. The server sees BOTH bags on ctx; Bob receives only what a handler chooses to return.
  const viaSealed = createSuperLineClient(app, { transport: transport(), role: 'user', params: { jwt: sealedToken } })
  console.log('  server read the sealed key →', await viaSealed.useUpstream())
  await viaSealed.env.ready // the first env frame lands at accept; awaiting it kills the connect-time race
  console.log('  Bob’s client.env →', viaSealed.env.current) // the PUBLIC half only, via resolveEnv
  const sealedSession = (await srv.collection('sessions').snapshot()).find((s) => s.authMethod === 'jwt-sealed')
  console.log('  session row →', { authMethod: sealedSession?.authMethod, userId: sealedSession?.userId })
  viaSealed.close()

  // Roles are NOT baked into a sealed assertion — connect reads them from the user row, so a grant made
  // after minting is live on the very next connection, and the mint site cannot escalate anyone.
  console.log('  roles reported by verify →', (await authKit.tokens.verify(sealedToken))?.roles)

  // 3 · The cost of statelessness, stated plainly. `revoke` flushes access tokens, ends sessions and
  //     disconnects Bob everywhere — but an outstanding JWT is in no table, so there is nothing to
  //     revoke. It keeps working until it expires. Short TTLs are the mitigation, not revocation.
  console.log('\n— Bob is revoked —')
  await authKit.revoke(bobId)
  const afterRevoke = createSuperLineClient(app, { transport: transport(), role: 'user', params: { jwt } })
  console.log('  whoami over jwt →', await afterRevoke.whoami()) // still Bob — the signature is still valid
  afterRevoke.close()

  // 4 · …and the emergency stop. `resolveBase` reads the user row to check for deactivation — the one
  //     deliberate dent in statelessness — so deactivating Bob closes even the signed door.
  console.log('\n— Bob is deactivated —')
  await authKit.users.deactivate(bobId)
  const afterDeactivate = createSuperLineClient(app, { transport: transport(), role: 'user', params: { jwt } })
  console.log('  whoami over jwt →', await afterDeactivate.whoami()) // null — accepted as a guest
  afterDeactivate.close()

  // ── Sign out revokes the session; the client drops back to guest. ──
  console.log('\n— Alice signs out —')
  await alice.signOut()
  console.log('  state  →', alice.state.status) // 'guest'
  console.log('  whoami →', await alice.client.whoami()) // null

  alice.client.close()
  bob.client.close()
  await srv.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
