import { describe, expect, it } from 'vitest'
import { wsServerRawConn } from '../src/index.js'

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

describe('ws backpressure', () => {
  it('sends normally when under the limit', () => {
    const ws = fakeWs()
    const raw = wsServerRawConn(ws as never, { maxBufferedBytes: 1000 })
    raw.send('x')
    expect(ws.sent).toHaveLength(1)
    expect(ws.closedWith).toBeUndefined()
  })

  it("closes with 1013 when over the limit (default 'close')", () => {
    const ws = fakeWs()
    ws.bufferedAmount = 2000
    const raw = wsServerRawConn(ws as never, { maxBufferedBytes: 1000 })
    raw.send('x')
    expect(ws.sent).toHaveLength(0)
    expect(ws.closedWith).toBe(1013)
  })

  it("drops the frame but keeps the connection with onExceed 'drop'", () => {
    const ws = fakeWs()
    ws.bufferedAmount = 2000
    const raw = wsServerRawConn(ws as never, { maxBufferedBytes: 1000, onExceed: 'drop' })
    raw.send('x')
    expect(ws.sent).toHaveLength(0)
    expect(ws.closedWith).toBeUndefined()
  })

  it('never interferes when backpressure is unset', () => {
    const ws = fakeWs()
    ws.bufferedAmount = 10_000_000
    const raw = wsServerRawConn(ws as never)
    raw.send('x')
    expect(ws.sent).toHaveLength(1)
  })
})
