import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthOutcome, Handshake, RawConn } from '@super-line/core'
import { httpServerTransport, httpClientTransport } from '../src/index.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

interface Accepted {
  raw: RawConn
  auth: AuthOutcome
  messages: Uint8Array[]
  closes: number[]
}

async function listen(
  authenticate: (h: Handshake) => Promise<AuthOutcome>,
  opts: { maxBodyBytes?: number } = {},
) {
  const accepted: Accepted[] = []
  const server = http.createServer()
  const transport = httpServerTransport({ server, ...opts })
  transport.start({
    authenticate,
    onConnection(raw, auth) {
      const rec: Accepted = { raw, auth, messages: [], closes: [] }
      raw.onMessage((b) => rec.messages.push(b))
      raw.onClose((code) => rec.closes.push(code))
      accepted.push(rec)
    },
  })
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as AddressInfo
  cleanups.push(async () => {
    await transport.stop()
    await new Promise<void>((r) => server.close(() => r()))
  })
  return { url: `http://127.0.0.1:${port}`, transport, accepted }
}

const ok = async (): Promise<AuthOutcome> => ({ role: 'user', ctx: {} })

async function waitFor(pred: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('http transport — server endpoints', () => {
  it('passes a Handshake (transport + query) to authenticate', async () => {
    let seen: Handshake | undefined
    const { url } = await listen(async (h) => {
      seen = h
      return { role: 'user', ctx: {} }
    })
    await fetch(`${url}/superline/handshake?role=user&token=abc`)
    expect(seen?.transport).toBe('longpoll')
    expect(seen?.query).toMatchObject({ role: 'user', token: 'abc' })
  })

  it('rejects the SSE handshake with 401 when authenticate throws (no session)', async () => {
    const { url, accepted } = await listen(async () => {
      throw new Error('denied')
    })
    const res = await fetch(`${url}/superline/sse?role=user`)
    expect(res.status).toBe(401)
    await res.text()
    expect(accepted).toHaveLength(0)
  })

  it('rejects the long-poll handshake with 401 when authenticate throws', async () => {
    const { url, accepted } = await listen(async () => {
      throw new Error('denied')
    })
    const res = await fetch(`${url}/superline/handshake?role=user`)
    expect(res.status).toBe(401)
    expect(accepted).toHaveLength(0)
  })

  it('returns 410 for /send and /poll to an unknown sid', async () => {
    const { url } = await listen(ok)
    const send = await fetch(`${url}/superline/send?sid=nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frames: [] }),
    })
    expect(send.status).toBe(410)
    const poll = await fetch(`${url}/superline/poll?sid=nope`)
    expect(poll.status).toBe(410)
  })

  it('returns 413 for an oversize POST body', async () => {
    const { url } = await listen(ok, { maxBodyBytes: 16 })
    const { sid } = (await (await fetch(`${url}/superline/handshake?role=user`)).json()) as { sid: string }
    const res = await fetch(`${url}/superline/send?sid=${sid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frames: ['x'.repeat(1000)] }),
    })
    expect(res.status).toBe(413)
  })

  it('does not touch responses for paths outside basePath (pass-through)', async () => {
    const accepted: Accepted[] = []
    const server = http.createServer((_req, res) => {
      res.writeHead(200)
      res.end('from-user-handler')
    })
    const transport = httpServerTransport({ server })
    transport.start({ authenticate: ok, onConnection: (raw, auth) => accepted.push({ raw, auth, messages: [], closes: [] }) })
    await new Promise<void>((r) => server.listen(0, r))
    const { port } = server.address() as AddressInfo
    cleanups.push(async () => {
      await transport.stop()
      await new Promise<void>((r) => server.close(() => r()))
    })
    const res = await fetch(`http://127.0.0.1:${port}/unrelated`)
    expect(await res.text()).toBe('from-user-handler')
    // a sibling path that merely shares the basePath PREFIX is NOT ours — must pass through, not 404/crash
    const sibling = await fetch(`http://127.0.0.1:${port}/superline-admin/dashboard`)
    expect(await sibling.text()).toBe('from-user-handler')
  })
})

describe('http transport — lifecycle', () => {
  it('server close() fires onClose(1000); terminate() fires 1006', async () => {
    const { url, accepted } = await listen(ok)
    await fetch(`${url}/superline/handshake?role=user`)
    await fetch(`${url}/superline/handshake?role=user`)
    await waitFor(() => accepted.length === 2)
    accepted[0]!.raw.close()
    accepted[1]!.raw.terminate()
    expect(accepted[0]!.closes).toEqual([1000])
    expect(accepted[1]!.closes).toEqual([1006])
    expect(accepted[0]!.raw.writable).toBe(false)
  })

  it('server.stop() closes live sessions with 1006', async () => {
    const { url, transport, accepted } = await listen(ok)
    await fetch(`${url}/superline/handshake?role=user`)
    await waitFor(() => accepted.length === 1)
    await transport.stop()
    expect(accepted[0]!.closes).toEqual([1006])
  })

  it('client close() fires client onClose(1000) and tells the server (long-poll)', async () => {
    const { url, accepted } = await listen(ok)
    const events = { opened: false, closes: [] as number[] }
    const raw = httpClientTransport({ url, mode: 'longpoll' }).connect(
      { role: 'user' },
      {
        onOpen: () => (events.opened = true),
        onMessage: () => {},
        onClose: (c) => events.closes.push(c),
        onDrain: () => {},
      },
    )
    cleanups.unshift(() => raw.close())
    await waitFor(() => events.opened && accepted.length === 1)
    raw.close()
    await waitFor(() => events.closes.length === 1)
    expect(events.closes).toEqual([1000])
    await waitFor(() => accepted[0]!.closes.length === 1)
    expect(accepted[0]!.closes).toEqual([1000])
  })
})
