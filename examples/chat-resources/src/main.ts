import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtMemoryCollections, crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { webSocketClientTransport, webSocketServerTransport } from '@super-line/transport-websocket'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chatContract } from '@super-line/plugin-chat'
import { chat } from '@super-line/plugin-chat/server'
import { chatClient } from '@super-line/plugin-chat/client'
import { chatAgentTools } from '@super-line/plugin-chat/ai-sdk'

// Channel resources (PLAN-chat-resources): the HOST declares its CRDT collections — chat makes them
// channel-native. Two kinds here: a todo list (owned — minted by chat, dies with its channel) and a
// canvas (linked — host-meaningful doc id, shareable across channels, chat never deletes it).
// Schemas are presence-tolerant (ADR-0008): concurrently-edited fields carry .catch().
const todoSchema = z.object({
  items: z.record(z.string(), z.object({ text: z.string(), done: z.boolean() })).catch({}),
})
const canvasSchema = z.object({
  name: z.string().catch(''),
  shapes: z.record(z.string(), z.object({ kind: z.string(), x: z.number(), y: z.number() })).catch({}),
  // catch-LESS on purpose (ADR-0008: strict is safe for fields not edited concurrently) — the one
  // field a bad write can actually be REJECTED on; .catch() fields self-heal instead of rejecting
  version: z.number().optional(),
})

const app = defineContract({
  collections: {
    todos: { schema: todoSchema, crdt: { mode: 'document' } },
    canvases: { schema: canvasSchema, crdt: { mode: 'document' } },
  },
  roles: { user: {} },
  plugins: [authContract(), chatContract()],
})

async function main(): Promise<void> {
  const server = http.createServer()
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
  const chatKit = chat({
    contract: app,
    resources: {
      kinds: {
        // registering a kind = createResource enabled + membership-gated doc policies + delete-cascade
        todo: { collection: 'todos', init: () => ({ items: {} }) },
        canvas: {
          collection: 'canvases',
          lifecycle: 'linked',
          init: (c) => ({ name: typeof c.params.name === 'string' ? c.params.name : 'untitled', shapes: {} }),
        },
      },
    },
  })

  createSuperLineServer(app, {
    transports: [webSocketServerTransport({ server })],
    collections: backend,
    crdtCollections: crdtMemoryCollections(),
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    plugins: [authKit.plugin, chatKit.plugin],
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const connect = (params: Record<string, string>) =>
    createSuperLineClient(app, {
      transport: webSocketClientTransport({ url }),
      role: 'user',
      params,
      crdtCollections: crdtCollectionsClient(),
    })

  // ── Alice: a human member ───────────────────────────────────────────────────────────────────────
  const guest = createSuperLineClient(app, { transport: webSocketClientTransport({ url }), role: 'guest' })
  const { token, userId: aliceId } = await guest.signUp({
    email: 'alice@example.com',
    password: 'passpass',
    displayName: 'Alice',
  })
  guest.close()
  const aliceRaw = connect({ token })
  const alice = chatClient(aliceRaw, { userId: aliceId })

  const channel = await alice.createChannel({ name: 'design' })
  console.log(`[alice] created #${channel.name}`)

  // an OWNED todo list, minted by chat; and a LINKED canvas attached under a host id
  const todo = await alice.createResource(channel.id, { kind: 'todo', title: 'Launch checklist' })
  const canvas = await alice.createResource(channel.id, {
    kind: 'canvas',
    id: 'brand-hero', // the host's own doc id (think: a content UUID)
    title: 'Brand hero',
    params: { name: 'Brand hero v1' },
  })
  console.log(`[alice] resources: ${(await waitRows(alice.resources(channel.id))).map((r) => `${r.kind}/${r.docId}`).join(', ')}`)

  // Alice collaborates through the native live DocHandle (optimistic, resync-on-reject)
  const aliceTodo = aliceRaw.collection('todos').open(todo.docId)
  await aliceTodo.ready
  aliceTodo.update({ items: { 'i-1': { text: 'pick a palette', done: false } } })

  // ── Automation is an ordinary authenticated member; the host owns its lifecycle ───────────────
  const automationGuest = createSuperLineClient(app, {
    transport: webSocketClientTransport({ url }),
    role: 'guest',
  })
  const { token: automationToken, userId: automationId } = await automationGuest.signUp({
    email: 'design-automation@example.com',
    password: 'passpass',
    displayName: 'Design Automation',
  })
  automationGuest.close()
  await alice.addMember(channel.id, automationId)
  const automationRaw = connect({ token: automationToken })
  const tools = chatAgentTools(automationRaw, {
    resourceShapes: {
      todo: '{ items: Record<id, { text: string, done: boolean }> }',
      canvas: '{ name: string, shapes: Record<id, { kind: string, x: number, y: number }> }',
    },
  })
  // no LLM in this example — we drive the same tools a model would call
  const run = (name: string, input: unknown): Promise<unknown> =>
    (tools[name]!.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: 't', messages: [] })

  console.log(`[automation] sees:`, await run('list_resources', { channelId: channel.id }))

  // the ACKED write path: the bot KNOWS its write landed (or reads the validation error)
  const written = (await run('write_resource', {
    channelId: channel.id,
    kind: 'todo',
    docId: todo.docId,
    ops: [
      { path: ['items', 'i-2'], set: { text: 'draft the hero shape', done: false } },
      { path: ['items', 'i-1', 'done'], set: true },
    ],
  })) as { ok?: boolean }
  console.log(`[automation] write acked: ${written.ok === true}`)

  const rejected = (await run('write_resource', {
    channelId: channel.id,
    kind: 'canvas',
    docId: 'brand-hero',
    ops: [{ path: ['version'], set: 'two' }],
  })) as { error?: string }
  console.log(`[automation] invalid write honestly rejected: ${rejected.error}`) // VALIDATION

  // Alice's live handle converged on the automation's writes — same doc, two collaborators
  await until(() => Object.keys((aliceTodo.getSnapshot() as z.infer<typeof todoSchema>).items).length === 2)
  console.log('[alice] todo now:', JSON.stringify(aliceTodo.getSnapshot()))

  // ── presence: who has the canvas open ───────────────────────────────────────────────────────────
  await alice.announceResource('canvas', 'brand-hero', 'open')
  await chatClient(automationRaw, { userId: automationId }).announceResource('canvas', 'brand-hero', 'open')
  const present = await waitRows(alice.resourcePresence(canvas.collection, 'brand-hero'))
  console.log(`[presence] brand-hero open by ${present.length} member(s)`)

  // ── lifecycle: the cascade deletes the owned todo doc but never the linked canvas ───────────────
  await alice.deleteChannel(channel.id)
  console.log(`[cascade] todo doc gone: ${(await chatKit.resources.of(channel.id)).length === 0}`)
  console.log('done — the linked canvas doc survives for the next channel that attaches it')

  aliceRaw.close()
  automationRaw.close()
  server.close()
}

async function waitRows<T>(store: { rows(): T[]; ready: Promise<void>; close(): void }): Promise<T[]> {
  await store.ready
  const rows = store.rows()
  store.close()
  return rows
}
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
