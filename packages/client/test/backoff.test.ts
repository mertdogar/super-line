import { describe, expect, it } from 'vitest'
import { backoffDelay } from '@super-line/client'

const opts = { baseMs: 100, maxMs: 2000, factor: 2 }

describe('backoffDelay (exponential + full jitter)', () => {
  it('stays within [raw/2, raw] and never exceeds maxMs', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const raw = Math.min(opts.maxMs, opts.baseMs * opts.factor ** attempt)
      for (let i = 0; i < 50; i++) {
        const d = backoffDelay(attempt, opts)
        expect(d).toBeGreaterThanOrEqual(raw / 2)
        expect(d).toBeLessThanOrEqual(raw)
        expect(d).toBeLessThanOrEqual(opts.maxMs)
      }
    }
  })

  it('caps at maxMs for large attempts', () => {
    expect(backoffDelay(50, opts)).toBeLessThanOrEqual(opts.maxMs)
    expect(backoffDelay(50, opts)).toBeGreaterThanOrEqual(opts.maxMs / 2)
  })
})
