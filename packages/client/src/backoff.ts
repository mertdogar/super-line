export interface BackoffOptions {
  baseMs: number
  maxMs: number
  factor: number
}

// Exponential backoff with full jitter: a random delay in [raw/2, raw],
// where raw = min(maxMs, baseMs * factor^attempt). attempt is 0-based.
export function backoffDelay(attempt: number, opts: BackoffOptions): number {
  const raw = Math.min(opts.maxMs, opts.baseMs * opts.factor ** attempt)
  return raw / 2 + Math.random() * (raw / 2)
}
