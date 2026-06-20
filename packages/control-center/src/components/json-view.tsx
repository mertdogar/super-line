import * as React from 'react'
import { cn } from '@/lib/utils'

export function Json({ data, className }: { data: unknown; className?: string }): React.JSX.Element {
  return (
    <pre
      className={cn(
        'max-h-[72vh] overflow-auto rounded-md border bg-background/40 p-3 text-xs leading-relaxed',
        className,
      )}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}
