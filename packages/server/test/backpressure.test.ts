import { describe, expect, it } from 'vitest'
import { jsonSerializer } from '@super-line/core'
import { Conn } from '@super-line/server'

function fakeWs() {
  return {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    sent: [] as unknown[],
    closedWith: undefined as number | undefined,
    send(d: unknown) {
      this.sent.push(d)
    },
    close(code?: number) {
      this.closedWith = code
    },
  }
}

function conn(ws: ReturnType<typeof fakeWs>, backpressure?: { maxBufferedBytes: number; onExceed?: 'close' | 'drop' }) {
  return new Conn(ws as never, 'c1', 'user', {}, jsonSerializer, backpressure)
}

describe('backpressure (slice 7)', () => {
  it('sends normally when under the limit', () => {
    const ws = fakeWs()
    const c = conn(ws, { maxBufferedBytes: 1000 })
    c.emit('x', { a: 1 })
    expect(ws.sent).toHaveLength(1)
    expect(ws.closedWith).toBeUndefined()
  })

  it("closes with 1013 when over the limit (default 'close')", () => {
    const ws = fakeWs()
    ws.bufferedAmount = 2000
    const c = conn(ws, { maxBufferedBytes: 1000 })
    c.emit('x', { a: 1 })
    expect(ws.sent).toHaveLength(0)
    expect(ws.closedWith).toBe(1013)
  })

  it("drops the frame but keeps the connection with onExceed 'drop'", () => {
    const ws = fakeWs()
    ws.bufferedAmount = 2000
    const c = conn(ws, { maxBufferedBytes: 1000, onExceed: 'drop' })
    c.emit('x', { a: 1 })
    expect(ws.sent).toHaveLength(0)
    expect(ws.closedWith).toBeUndefined()
  })

  it('never interferes when backpressure is unset', () => {
    const ws = fakeWs()
    ws.bufferedAmount = 10_000_000
    const c = conn(ws)
    c.emit('x', { a: 1 })
    expect(ws.sent).toHaveLength(1)
  })
})
