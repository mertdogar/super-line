// The one polling wait, shared by every package's tests. Lives in core/test (alongside
// collection-store-conformance) rather than server/test/harness so a suite that needs a wait
// doesn't pull the whole server+client+ws module graph in with it; harness re-exports it for
// the 55 files that already import it from there.
//
// It replaced 24 near-identical local copies whose defaults ranged 1s to 20s, all throwing a
// bare 'waitFor timeout' that named neither the condition nor how long it actually waited.

export const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface WaitForOptions {
  /** Ceiling before the wait gives up. A BACKSTOP, not a budget — the predicate is polled until it passes. */
  timeout?: number
  /** What is being waited for, quoted back on timeout. Worth writing wherever a bare failure would be cryptic. */
  label?: string
}

/**
 * Poll `pred` until it passes, backing off between attempts.
 *
 * The interval GROWS (5ms → 250ms) rather than staying tight, which matters on a contended
 * machine: a fixed short poll competes for the same CPU as the work it waits for, and when the
 * predicate itself costs something — a SQL query, a fold — a tight loop can starve its own
 * subject. A healthy run settles on the first or second poll and is unaffected either way.
 *
 * Raising a ceiling is nearly always the wrong fix. The ceiling only decides how long a already-
 * broken test takes to admit it; if a wait is losing, the predicate is being starved or the thing
 * it waits for never happened.
 */
export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  opts: number | WaitForOptions = {},
): Promise<void> {
  const { timeout = 2000, label } = typeof opts === 'number' ? ({ timeout: opts } as WaitForOptions) : opts
  const start = Date.now()
  let interval = 5
  while (!(await pred())) {
    if (Date.now() - start > timeout) {
      const waited = ((Date.now() - start) / 1000).toFixed(1)
      throw new Error(`waitFor timed out after ${waited}s${label ? ` waiting for: ${label}` : ''}`)
    }
    await tick(interval)
    interval = Math.min(interval * 2, 250)
  }
}

/**
 * A `waitFor` with a different default ceiling, for suites whose subject is genuinely slower —
 * containers, real Electric, in-process WASM Postgres. One implementation, per-file ceilings.
 */
export const waitForWith =
  (timeout: number) =>
  (pred: () => boolean | Promise<boolean>, opts: number | WaitForOptions = {}): Promise<void> =>
    waitFor(pred, typeof opts === 'number' ? { timeout: opts } : { timeout, ...opts })
