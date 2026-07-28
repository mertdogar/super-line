/**
 * Best-effort, never-throwing value snapshotting for display. Shared by every observer that has to
 * put a live app payload somewhere it cannot be mutated afterwards — the server inspector (which
 * sends it across the bus) and the client tap (whose consumer drains it through a channel that
 * accepts JSON and nothing else).
 *
 * The caps are the point: an observer must never be the reason a payload is retained, walked
 * forever, or fails to serialize.
 */

/** Deepest object nesting reproduced before the subtree collapses to `'[MaxDepth]'`. */
const MAX_DEPTH = 6
/** Longest array reproduced; the tail is dropped. */
const MAX_ARRAY = 1000

/**
 * Structurally copy `value` for display, replacing anything unserializable with a marker: functions,
 * symbols and bigints become strings, `Date`s become ISO strings, cycles become `'[Circular]'`, and
 * a non-plain prototype is recorded as a `#type` key rather than reconstructed. Keys named in
 * `redact` are replaced with `'[Redacted]'` at every depth.
 *
 * The result is always JSON-compliant, which is load-bearing for the client tap: its drain channel
 * throws on the whole batch — not the offending row — if any value is not.
 */
export function safeSnapshot(value: unknown, redact?: ReadonlySet<string>): unknown {
  return snapshot(value, redact, 0, new WeakSet<object>())
}

function snapshot(
  value: unknown,
  redact: ReadonlySet<string> | undefined,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'bigint') return `${(value as bigint).toString()}n`
  if (t === 'function') return '[Function]'
  if (t === 'symbol') return (value as symbol).toString()
  if (t !== 'object') return value // string | number | boolean | undefined
  const obj = value as object
  if (obj instanceof Date) return obj.toISOString()
  if (seen.has(obj)) return '[Circular]'
  if (depth >= MAX_DEPTH) return '[MaxDepth]'
  seen.add(obj)
  try {
    if (Array.isArray(obj)) return obj.slice(0, MAX_ARRAY).map((v) => snapshot(v, redact, depth + 1, seen))
    const ctor = (Object.getPrototypeOf(obj) as { constructor?: { name?: string } } | null)?.constructor?.name
    const out: Record<string, unknown> = {}
    if (ctor && ctor !== 'Object') out['#type'] = ctor
    for (const [k, v] of Object.entries(obj)) {
      out[k] = redact?.has(k) ? '[Redacted]' : snapshot(v, redact, depth + 1, seen)
    }
    return out
  } finally {
    seen.delete(obj)
  }
}
