/** Tuning for {@link backoffDelay}. */
export interface BackoffOptions {
  /** Initial delay in ms (attempt 0). */
  baseMs: number
  /** Upper bound on the delay in ms. */
  maxMs: number
  /** Exponential growth factor per attempt. */
  factor: number
}

/**
 * Exponential backoff with full jitter: a random delay in `[raw/2, raw]`, where
 * `raw = min(maxMs, baseMs * factor ** attempt)`. A pure function — easy to unit-test.
 *
 * @param attempt - 0-based retry attempt.
 * @param opts - backoff tuning.
 * @returns the delay in milliseconds before the next attempt.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions): number {
  const raw = Math.min(opts.maxMs, opts.baseMs * opts.factor ** attempt)
  return raw / 2 + Math.random() * (raw / 2)
}
