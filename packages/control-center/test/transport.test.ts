import { describe, expect, it } from 'vitest'
import {
  breakdownLabel,
  familyShort,
  transportFamily,
  transportLabel,
  transportsOf,
} from '../src/lib/transport.js'

describe('transportFamily', () => {
  it('collapses the HTTP sub-modes and passes the rest through', () => {
    expect(transportFamily('websocket')).toBe('websocket')
    expect(transportFamily('sse')).toBe('http')
    expect(transportFamily('longpoll')).toBe('http')
    expect(transportFamily('libp2p')).toBe('libp2p')
    expect(transportFamily('loopback')).toBe('loopback')
    expect(transportFamily(undefined)).toBe('unknown')
    expect(transportFamily('weird')).toBe('unknown')
  })
})

describe('transportLabel', () => {
  it('renders friendly labels, sub-mode included for HTTP', () => {
    expect(transportLabel('websocket')).toBe('WebSocket')
    expect(transportLabel('sse')).toBe('HTTP · SSE')
    expect(transportLabel('longpoll')).toBe('HTTP · long-poll')
    expect(transportLabel('libp2p')).toBe('libp2p')
    expect(transportLabel('loopback')).toBe('Loopback')
    expect(transportLabel(undefined)).toBe('unknown')
    expect(transportLabel('weird')).toBe('weird') // unknown literals pass through
  })
})

describe('familyShort', () => {
  it('shortens websocket to ws, families otherwise unchanged', () => {
    expect(familyShort('websocket')).toBe('ws')
    expect(familyShort('http')).toBe('http')
    expect(familyShort('libp2p')).toBe('libp2p')
  })
})

describe('transportsOf', () => {
  it('counts by family, busiest first, http collapsing sse+longpoll', () => {
    expect(
      transportsOf([
        { transport: 'websocket' },
        { transport: 'websocket' },
        { transport: 'websocket' },
        { transport: 'sse' },
        { transport: 'longpoll' },
      ]),
    ).toEqual([
      { family: 'websocket', count: 3 },
      { family: 'http', count: 2 },
    ])
  })
})

describe('breakdownLabel', () => {
  it('formats a compact "N ws / M http" summary', () => {
    expect(
      breakdownLabel([{ transport: 'websocket' }, { transport: 'sse' }, { transport: 'longpoll' }]),
    ).toBe('2 http / 1 ws')
    expect(breakdownLabel([])).toBe('')
  })
})
