import * as React from 'react'
import type { InspectorStatus } from '@/lib/inspector-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusDot } from '@/components/status-dot'

export function SettingsPage({
  url,
  status,
  onConnect,
}: {
  url: string
  status: InspectorStatus
  onConnect: (url: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = React.useState(url)
  React.useEffect(() => {
    setDraft(url)
  }, [url])
  const dirty = draft.trim() !== url

  return (
    <div className="max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Inspector connection</CardTitle>
          <p className="text-xs text-muted-foreground">
            The WebSocket endpoint of a super-line server started with <code>inspector: true</code>. Saved
            to this browser and reused next time.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="cc-url">
            URL
          </label>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              onConnect(draft.trim())
            }}
          >
            <input
              id="cc-url"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="ws://localhost:3000"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <Button type="submit" size="sm" variant={dirty ? 'default' : 'secondary'}>
              {dirty ? 'Connect' : 'Reconnect'}
            </Button>
          </form>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Status</span>
            <StatusDot status={status} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
