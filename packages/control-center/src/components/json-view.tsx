import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Json({ data, className }: { data: unknown; className?: string }): React.JSX.Element {
  const text = React.useMemo(() => JSON.stringify(data, null, 2), [data])
  const [copied, setCopied] = React.useState(false)

  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="relative">
      <pre
        className={cn(
          'max-h-[72vh] overflow-auto rounded-md border bg-background/40 p-3 text-xs leading-relaxed',
          className,
        )}
      >
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy JSON"
        title={copied ? 'Copied' : 'Copy JSON'}
        className="absolute right-2 top-2 rounded-md border bg-card/80 p-1.5 text-muted-foreground opacity-70 transition-opacity hover:text-foreground hover:opacity-100"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}
