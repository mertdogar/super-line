import * as React from 'react'
import { formatClock } from '../lib/labels.js'
import type { Entry } from '../lib/reduce.js'

/**
 * The wire token, as a dim monospace chip beside the English label.
 *
 * Both audiences are real: you read the label, and you screenshot the token into an issue. Dropping it
 * would leave Frames mode with no reason to exist; leading with it is what made the first version
 * unreadable.
 */
export function Wire({ children }: { children?: string }): React.JSX.Element | null {
  if (!children) return null
  return (
    <span className="shrink-0 rounded border border-[var(--color-line)] px-1 font-mono text-[10px] text-[var(--color-muted)] opacity-70">
      {children}
    </span>
  )
}

/** A visible break in the list. Never inferred silently — both kinds render in both modes. */
export function Divider({ entry }: { entry: Extract<Entry, { type: 'divider' }> }): React.JSX.Element {
  const dropped = entry.kind === 'dropped'
  return (
    <div
      className={`my-1 flex items-center gap-2 px-2 text-[11px] ${
        dropped ? 'text-[var(--color-warn)]' : 'text-[var(--color-muted)]'
      }`}
    >
      <span className="h-px flex-1 bg-current opacity-30" />
      <span>
        {dropped
          ? `${entry.count} events dropped — buffer overflowed`
          : `page load${entry.ts ? ` · ${formatClock(entry.ts)}` : ''}`}
      </span>
      <span className="h-px flex-1 bg-current opacity-30" />
    </div>
  )
}

/**
 * Scroll container that follows the tail only while the reader is already at the bottom — scrolling up
 * to read something must not be yanked away by the next event.
 */
export function Follow({ count, children }: { count: number; children: React.ReactNode }): React.JSX.Element {
  const endRef = React.useRef<HTMLDivElement>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [stick, setStick] = React.useState(true)

  React.useEffect(() => {
    if (stick) endRef.current?.scrollIntoView({ block: 'end' })
  }, [count, stick])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className="min-w-0 flex-1 overflow-auto">
      {children}
      <div ref={endRef} />
    </div>
  )
}
