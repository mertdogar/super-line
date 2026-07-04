import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { chat } from '../src/contract.js'
import { moderation } from '../src/moderation/server.js'

const waitFor = async (p: () => boolean, ms = 1000): Promise<void> => {
  const t0 = Date.now()
  while (!p()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

// One end-to-end pass through the moderation plugin: mod-auth, the muted-send gate, the mod.status
// push, and unmute. Single boot/teardown to keep the ws handles from lingering across tests.
it('gates muted sends, enforces mod-auth, and restores on unmute', async () => {
  const httpServer = http.createServer()
  const srv = createSuperLineServer(chat, {
    transports: [webSocketServerTransport({ server: httpServer })],
    authenticate: (h) => {
      const name = h.query.name?.trim()
      if (!name) throw new Error('name required')
      return { role: 'user' as const, ctx: { name, mod: h.query.mod === '1' } }
    },
    identify: (conn) => (conn.ctx as { name?: string }).name,
    plugins: [moderation({ isModerator: (ctx) => (ctx as { mod?: boolean }).mod === true, audit: () => {} })],
  })
  srv.implement({
    user: {
      join: async ({ room }, _ctx, conn) => {
        srv.room(room).add(conn)
        return { ok: true, count: 1 }
      },
      send: async ({ room, text }, ctx) => {
        srv.room(room).broadcast('message', { room, id: 'm', text, from: ctx.name, at: 0 })
        return { id: 'm' }
      },
    },
  })
  await new Promise<void>((r) => httpServer.listen(0, r))
  const url = `ws://localhost:${(httpServer.address() as AddressInfo).port}`
  const mk = (name: string, mod = false) =>
    createSuperLineClient(chat, { transport: webSocketClientTransport({ url }), role: 'user', params: { name, mod: mod ? '1' : '' } })

  const ada = mk('ada', true) // moderator
  const bob = mk('bob')
  let status: { muted: boolean; by?: string } | undefined
  bob.on('mod.status', (s) => (status = s))
  await bob.join({ room: 'r' })

  // a non-moderator cannot issue mod commands
  await expect(bob['mod.mute']({ user: 'carol' })).rejects.toMatchObject({ code: 'FORBIDDEN' })

  // the moderator mutes bob: the list updates, and bob is notified
  expect((await ada['mod.mute']({ user: 'bob' })).muted).toEqual(['bob'])
  await waitFor(() => status?.muted === true)
  expect(status?.by).toBe('ada')

  // bob's send is now gated by the plugin's middleware
  await expect(bob.send({ room: 'r', text: 'hi' })).rejects.toMatchObject({ code: 'FORBIDDEN' })

  // unmute restores sending
  expect((await ada['mod.unmute']({ user: 'bob' })).muted).toEqual([])
  await expect(bob.send({ room: 'r', text: 'ok' })).resolves.toMatchObject({ id: 'm' })

  ada.close()
  bob.close()
  await srv.close()
  await new Promise<void>((r) => httpServer.close(() => r()))
})
