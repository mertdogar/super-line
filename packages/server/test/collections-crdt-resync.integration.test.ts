import { defineContract } from '@super-line/core'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { createSuperLineServer } from '@super-line/server'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { crdtMemoryCollections, crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'

// A record-of-full-objects schema (like ai-canvas-pglite's scene): every shape needs ALL fields, so a partial
// write to a NON-existent shape produces an incomplete row that validate-before-commit rejects.
const contract = defineContract({
  collections: {
    scenes: {
      schema: z.object({ shapes: z.record(z.string(), z.object({ x: z.number(), y: z.number(), color: z.string() })) }),
      crdt: { mode: 'document' },
    },
  },
  roles: { user: { clientToServer: {} } },
})
type Client = SuperLineClient<typeof contract, 'user'>
type Scene = { shapes: Record<string, { x: number; y: number; color: string }> }

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function setup() {
  const loop = createLoopbackTransport()
  const errors: Array<{ store: string; id: string }> = []
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
    identify: (conn) => (conn.ctx as { uid?: string }).uid,
    crdtCollections: crdtMemoryCollections(),
    policies: { scenes: { read: () => true, write: () => true } },
  })
  const clients: Client[] = []
  const makeClient = (uid: string): Client => {
    const cl = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      params: { uid },
      crdtCollections: crdtCollectionsClient(),
      onStoreError: (_e, info) => errors.push(info),
    })
    clients.push(cl)
    return cl
  }
  return { srv, makeClient, clients, errors }
}

describe('CRDT reject→resync recovery (ai-canvas-pglite stuck-loop repro)', () => {
  let env: ReturnType<typeof setup>
  afterEach(async () => {
    for (const c of env.clients) c.close()
    await env.srv.close()
  })

  it('a rejected write resyncs to a CLEAN state — the phantom is dropped and later writes converge', async () => {
    env = setup()
    await env.srv.collection('scenes').create('board', { shapes: {} })
    const doc = env.makeClient('alice').collection('scenes').open('board')
    await doc.ready

    // A valid shape commits. Poll the server co-writer's snapshot for the canonical state.
    const serverSnap = (): Scene => env.srv.collection('scenes').open('board').getSnapshot() as Scene
    doc.update({ shapes: { A: { x: 1, y: 1, color: 'red' } } })
    await waitFor(() => !!serverSnap().shapes.A)

    // A partial write to a NEW shape B (missing `color`) — invalid on the server → rejected → resync.
    doc.update({ shapes: { B: { x: 2, y: 2 } } as unknown as Scene['shapes'] })
    await waitFor(() => env.errors.length > 0)

    // After the resync, B (the phantom) must be GONE from the client, and the doc structurally clean.
    await waitFor(() => {
      const s = doc.getSnapshot() as Scene
      return !s.shapes.B && !!s.shapes.A
    })
    expect(Object.keys((doc.getSnapshot() as Scene).shapes)).toEqual(['A'])

    // And a subsequent VALID write must converge to the server (no stuck rejection loop).
    const before = env.errors.length
    doc.update({ shapes: { A: { x: 99, y: 99, color: 'blue' } } })
    await waitFor(() => serverSnap().shapes.A?.x === 99)
    expect(env.errors.length).toBe(before) // no new rejection — the replica recovered structurally
  })
})
