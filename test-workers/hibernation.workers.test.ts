import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'
import { createSuperLineClient, type ClientErrorInfo } from '@super-line/client'
import type { SuperLineError } from '@super-line/core'
import { waitFor } from '../packages/core/test/wait.js'
import { appContract, stubTransport } from './app.js'

// A super-line node in a real Durable Object, evicted mid-test: the socket hibernates, the next message wakes a
// NEW instance (the constructor runs again), and the connection carries on as if nothing happened.

const clients: Array<{ close(): void }> = []
afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

function setup() {
  const stub = env.APP.get(env.APP.idFromName(`app-${crypto.randomUUID()}`))
  const lifecycle: string[] = []
  const errors: Array<{ code: string; info: ClientErrorInfo }> = []
  const client = createSuperLineClient(appContract, {
    transport: stubTransport(stub),
    role: 'user',
    params: { uid: 'alice' },
    onDisconnect: (code) => lifecycle.push(`disconnect:${code}`),
    onReconnect: () => lifecycle.push('reconnect'),
    onError: (err, info) => errors.push({ code: (err as SuperLineError).code, info }),
    reconnectBaseMs: 10,
  })
  clients.push(client)
  const sql = <T>(query: string) => runInDurableObject(stub, (_i, state) => state.storage.sql.exec(query).toArray() as T[])
  const boots = async () => (await sql<{ v: number }>("SELECT v FROM app_state WHERE k = 'boots'"))[0]!.v
  return { stub, client, lifecycle, errors, sql, boots }
}

describe('a super-line node in a Durable Object', () => {
  it('a subscription survives eviction: the next message wakes a new instance that resumes it', async () => {
    const { stub, client, lifecycle, boots, sql } = setup()
    const got: string[] = []
    await client.subscribe('announce', (d) => got.push(d.msg)).ready
    expect(await boots()).toBe(1)

    await evictDurableObject(stub)
    await client.shout({ msg: 'after wake' }) // this request is what wakes the object

    await waitFor(() => got.includes('after wake'))
    expect(await boots()).toBe(2)
    expect(lifecycle).toEqual([])

    client.close()
    await waitFor(async () => (await sql('SELECT id FROM _sl_conn')).length === 0) // closing forgets the snapshot
  })

  it('a subscription the woken instance refuses reaches onError while the socket stays open', async () => {
    const { stub, client, lifecycle, errors } = setup()
    await client.subscribe('announce', () => {}).ready
    await client.lock()

    await evictDurableObject(stub)
    expect(await client.ping({ n: 1 })).toEqual({ n: 1 })

    await waitFor(() => errors.length === 1)
    expect(errors[0]).toEqual({ code: 'FORBIDDEN', info: { kind: 'resubscribe', topic: 'announce' } })
    expect(lifecycle).toEqual([])
  })

  it('a socket whose snapshot is gone is closed 4409 on wake, and the client reconnects', async () => {
    const { stub, client, lifecycle, sql } = setup()
    expect(await client.ping({ n: 1 })).toEqual({ n: 1 })
    await sql('DELETE FROM _sl_conn')

    await evictDurableObject(stub)
    await expect(client.ping({ n: 2 })).rejects.toThrow()

    await waitFor(() => lifecycle.includes('reconnect'))
    expect(lifecycle[0]).toBe('disconnect:4409')
    expect(await client.ping({ n: 3 })).toEqual({ n: 3 })
  })
})
