import * as React from 'react'
import type { InspectorStatus } from '@/lib/inspector-client'
import { cn } from '@/lib/utils'

export function StatusDot({ status }: { status: InspectorStatus }): React.JSX.Element {
  const color =
    status === 'open' ? 'bg-primary' : status === 'connecting' ? 'bg-muted-foreground' : 'bg-destructive'
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span className={cn('h-2 w-2 rounded-full', color)} />
      {status}
    </span>
  )
}
