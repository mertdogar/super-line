import http from 'node:http'
import type { AddressInfo } from 'node:net'
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
    user: {}, // a plain user acts through the notes collection + the shared whoami/signOut
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

async function main(): Promise<void> {
  const server = http.createServer()
  const backend = memoryCollections()
  // The SAME backend is handed to both the auth kit (so `authenticate` can read sessions/users) and the server.
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })

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
  srv.implement({ admin: { stats: async () => ({ users: (await srv.collection('users').snapshot()).length }) } })

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
