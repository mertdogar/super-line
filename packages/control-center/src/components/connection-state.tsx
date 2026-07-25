import * as React from 'react'
import { RotateCw } from 'lucide-react'
import type { InspectorStatus } from '@/lib/inspector-client'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'

/**
 * The first-class content-area state for when there's nothing live to show — it DIAGNOSES instead of
 * leaving a blank graph: connecting vs. closed vs. connected-but-silent, with the target URL, the likely
 * reason, a Retry, and a hint. The EKG mark breathes/flatlines to match the status.
 */
export function ConnectionState({
  status,
  url,
  onRetry,
}: {
  status: InspectorStatus
  url: string
  onRetry: () => void
}): React.JSX.Element {
  // `status` is already de-strobed upstream (useInspector holds a failed connect at a steady 'closed'
  // through the silent auto-retries), so this state can render it straight.
  const copy =
    status === 'connecting'
      ? { title: 'Connecting…', detail: `Reaching the inspector at ${url}.`, hint: null as string | null }
      : status === 'closed'
        ? {
            title: 'Can’t reach the inspector',
            detail: `No inspector answered at ${url}. The server may be down, on another port, or not exposing the inspector.`,
            hint: 'Make sure the server mounts inspector() in its plugins, then set the right URL under Settings. Retrying automatically every second.',
          }
        : {
            title: 'Connected · no nodes reporting',
            detail: `The inspector at ${url} is reachable, but no super-line node has reported yet.`,
            hint: 'Waiting for the first topology heartbeat — this clears as soon as a node checks in.',
          }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <BrandMark status={status} className="h-14 w-28" />
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold">{copy.title}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{copy.detail}</p>
      </div>
      <code className="rounded-md border bg-card/60 px-2.5 py-1 font-mono text-xs text-foreground">{url}</code>
      {status !== 'connecting' ? (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RotateCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      ) : null}
      {copy.hint ? <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{copy.hint}</p> : null}
    </div>
  )
}
