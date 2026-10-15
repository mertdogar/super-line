import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cloudflareServerTransport } from '../src/transport.js'

// A Durable Object hibernates only when no timer is pending (`waitUntil` has no effect there), so a held busy
// token must leave one pending. Runs in Node against a stand-in for the object's state.
const state = () =>
  ({
    storage: { sql: { exec: () => ({ toArray: () => [] }) } },
    setWebSocketAutoResponse: () => {},
    getWebSockets: () => [],
  }) as unknown as DurableObjectState

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocketRequestResponsePair', class {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('a held busy token keeps one timer pending until every hold is released', () => {
  const transport = cloudflareServerTransport(state())
  expect(vi.getTimerCount()).toBe(0)
  transport.onHold!(1)
  transport.onHold!(2)
  expect(vi.getTimerCount()).toBe(1)
  transport.onHold!(1)
  expect(vi.getTimerCount()).toBe(1)
  transport.onHold!(0)
  expect(vi.getTimerCount()).toBe(0)
})
