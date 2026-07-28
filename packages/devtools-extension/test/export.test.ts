import { describe, expect, it } from 'vitest'
import type { ClientTapEvent } from '@super-line/core'
import { exportCsv, exportJson, exportJsonl, exportRows, serialize, stampOf } from '../src/lib/export.js'
import { toOperations } from '../src/lib/operations.js'
import type { Entry } from '../src/lib/reduce.js'

let seq = 0
const row = (event: ClientTapEvent, ts = 1_000 + seq): Entry => ({
  type: 'row',
  seq: ++seq,
  ts,
  clientId: 'c1',
  event,
})
const out = (f: unknown, bytes = 163): ClientTapEvent => ({ k: 'frame', dir: 'out', f: f as never, bytes })
const inb = (f: unknown, bytes = 281): ClientTapEvent => ({ k: 'frame', dir: 'in', f: f as never, bytes })

const sample = (): Entry[] => {
  seq = 0
  return [
    row(out({ t: 'req', i: 8, m: 'sendMessage', d: { content: 'hi' } }), 1000),
    row(inb({ t: 'res', i: 8, d: { id: 'm1' } }), 1009),
    row(out({ t: 'csub', i: 9, n: 'messages', s: 1, q: {} }), 1010),
  ]
}

const ctx = {
  mode: 'activity' as const,
  pageLoadId: 'qtc2krem',
  tapVersion: 1,
  filter: { text: 'send' },
  now: Date.UTC(2026, 6, 29, 12, 0, 0),
}

describe('exportRows', () => {
  it('writes merged operations in activity mode', () => {
    const entries = sample()
    const rows = exportRows(entries, toOperations(entries), 'activity') as Record<string, unknown>[]
    expect(rows).toHaveLength(2) // the request and its response are ONE row
    expect(rows[0]).toMatchObject({
      op: 'request',
      name: 'sendMessage',
      ok: true,
      latencyMs: 9,
      reqBytes: 163,
      resBytes: 281,
    })
  })

  it('writes raw records in frames mode', () => {
    const entries = sample()
    const rows = exportRows(entries, toOperations(entries), 'frames') as Record<string, unknown>[]
    expect(rows).toHaveLength(3) // every frame, unmerged
    expect(rows[0]).toHaveProperty('event')
    expect(rows[0]).toHaveProperty('seq')
  })

  it('leaves ok empty for a pending operation rather than asserting failure', () => {
    seq = 0
    const entries = [row(out({ t: 'req', i: 1, m: 'slow' }))]
    const rows = exportRows(entries, toOperations(entries), 'activity') as Record<string, unknown>[]
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.ok).toBe('') // not false — it has no verdict yet
  })
})

describe('exportJson', () => {
  it('carries an envelope that explains the file, including the active filter', () => {
    const entries = sample()
    const rows = exportRows(entries, toOperations(entries), 'activity')
    const parsed = JSON.parse(exportJson(rows, ctx))
    expect(parsed).toMatchObject({
      source: 'super-line devtools',
      mode: 'activity',
      pageLoadId: 'qtc2krem',
      tapVersion: 1,
      count: 2,
    })
    // without this, a filtered export is indistinguishable from a complete one
    expect(parsed.filter).toEqual({ text: 'send' })
    expect(parsed.exportedAt).toBe('2026-07-29T12:00:00.000Z')
  })
})

describe('exportJsonl', () => {
  it('writes one object per line with no wrapper', () => {
    const entries = sample()
    const rows = exportRows(entries, toOperations(entries), 'activity')
    const lines = exportJsonl(rows).split('\n')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('is empty for no rows', () => {
    expect(exportJsonl([])).toBe('')
  })
})

describe('exportCsv', () => {
  it('emits a header and one line per operation', () => {
    const entries = sample()
    const rows = exportRows(entries, toOperations(entries), 'activity')
    const lines = exportCsv(rows).split('\n')
    expect(lines[0]).toContain('latencyMs')
    expect(lines[0]).toContain('name')
    expect(lines).toHaveLength(3) // header + 2
    expect(lines[1]).toContain('sendMessage')
  })

  it('quotes values that would otherwise break the row apart', () => {
    const csv = exportCsv([{ a: 'has, comma', b: 'has "quote"', c: 'has\nnewline' }])
    const [, line] = csv.split('\n')
    expect(line).toContain('"has, comma"')
    expect(line).toContain('"has ""quote"""')
    expect(csv).toContain('"has\nnewline"')
  })

  it('collapses a raw frame into a single event column, since frames have no fixed shape', () => {
    const entries = sample()
    const rows = exportRows(entries, toOperations(entries), 'frames')
    const header = exportCsv(rows).split('\n')[0]!
    expect(header).toBe('seq,ts,time,client,event')
  })

  it('is empty for no rows', () => {
    expect(exportCsv([])).toBe('')
  })
})

describe('serialize + stamp', () => {
  it('routes each format', () => {
    const rows = [{ a: 1 }]
    expect(serialize(rows, 'json', ctx)).toContain('"source"')
    expect(serialize(rows, 'jsonl', ctx)).toBe('{"a":1}')
    expect(serialize(rows, 'csv', ctx)).toBe('a\n1')
  })

  it('stamps a filename-safe, sortable timestamp', () => {
    expect(stampOf(ctx.now)).toBe('2026-07-29T12-00-00')
    expect(stampOf(ctx.now)).not.toMatch(/[:.]/)
  })
})
