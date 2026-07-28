import * as React from 'react'
import type { InspectorStatus } from '@/lib/inspector-client'
import type { InspectorCredentials } from '@/hooks/use-inspector'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusDot } from '@/components/status-dot'

const FIELD =
  'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring'
const LABEL = 'text-xs font-medium uppercase tracking-wide text-muted-foreground'

export function SettingsPage({
  url,
  credentials,
  status,
  authReason,
  onConnect,
}: {
  url: string
  credentials: InspectorCredentials
  status: InspectorStatus
  authReason?: string
  onConnect: (url: string, credentials: InspectorCredentials) => void
}): React.JSX.Element {
  const [draft, setDraft] = React.useState(url)
  const [user, setUser] = React.useState(credentials.user)
  const [password, setPassword] = React.useState(credentials.password)
  React.useEffect(() => {
    setDraft(url)
    setUser(credentials.user)
    setPassword(credentials.password)
  }, [url, credentials.user, credentials.password])
  const dirty = draft.trim() !== url || user !== credentials.user || password !== credentials.password

  return (
    <div className="max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Inspector connection</CardTitle>
          <p className="text-xs text-muted-foreground">
            The WebSocket endpoint of a super-line server with the <code>inspector()</code> plugin mounted. Saved
            to this browser and reused next time.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              onConnect(draft.trim(), { user: user.trim(), password })
            }}
          >
            <label className={LABEL} htmlFor="cc-url">
              URL
            </label>
            <input
              id="cc-url"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="ws://localhost:3000"
              className={FIELD}
            />
            <label className={LABEL} htmlFor="cc-user">
              Credentials
            </label>
            <p className="-mt-1 text-xs text-muted-foreground">
              Only for a server running <code>inspector(&#123; auth &#125;)</code>. Leave blank otherwise. Stored
              in this browser and sent as handshake parameters — kept out of the URL above, which is displayed and
              shared.
            </p>
            <div className="flex items-center gap-2">
              <input
                id="cc-user"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="admin"
                autoComplete="username"
                className={FIELD}
              />
              <input
                id="cc-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="password"
                autoComplete="current-password"
                className={FIELD}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" variant={dirty ? 'default' : 'secondary'}>
                {dirty ? 'Connect' : 'Reconnect'}
              </Button>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Status</span>
                <StatusDot status={status} />
              </div>
            </div>
          </form>
          {status === 'unauthorized' ? (
            <p className="text-xs text-destructive">
              {authReason ? `Rejected: ${authReason}` : 'The server rejected these credentials.'}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
