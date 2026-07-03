import * as React from 'react'
import type { InspectorStatus } from '@/lib/inspector-client'
import { cn } from '@/lib/utils'

/**
 * The super-line pulse mark, doubling as a status EKG: a faint signal sweeps the wire while
 * connected, the pulse breathes while connecting, and it flatlines when the wire is closed.
 * CSS-only (`cc-sweep`/`cc-breathe` in index.css); honors prefers-reduced-motion.
 */
export function BrandMark({ status }: { status: InspectorStatus }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 44 24"
      className="h-6 w-11 shrink-0"
      role="img"
      aria-label={`super-line — inspector ${status}`}
    >
      <g fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12 H12" className="stroke-foreground/80" />
        <path
          d="M12 12 L18 4 L25 20 L31 12"
          vectorEffect="non-scaling-stroke"
          className={cn(
            'transition-all duration-700 [transform-box:fill-box] [transform-origin:center]',
            status === 'closed' ? 'scale-y-[0.04] stroke-muted-foreground' : 'stroke-primary',
            status === 'connecting' && 'cc-breathe',
          )}
        />
        <path d="M31 12 H42" className="stroke-foreground/80" />
        {status === 'open' ? (
          <path d="M2 12 H12 L18 4 L25 20 L31 12 H42" pathLength={100} className="cc-sweep stroke-primary" />
        ) : null}
      </g>
    </svg>
  )
}
