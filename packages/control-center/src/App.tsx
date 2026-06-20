import * as React from 'react'
import { Boxes, FileText, Network, Radio } from 'lucide-react'
import type {
  ConnDescriptor,
  InspectedContract,
  InspectorEvent,
  NodeStat,
  NodeView,
} from '@super-line/core'
import { useInspector } from '@/hooks/use-inspector'
import type { InspectorStatus } from '@/lib/inspector-client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TopologyGraph } from '@/components/topology-graph'
import { RoomLens } from '@/components/room-lens'
import { roomsOf } from '@/lib/topology'
import { cn } from '@/lib/utils'

type View = 'topology' | 'connections' | 'contract' | 'feed'

const NAV: Array<{ id: View; label: string; icon: typeof Network }> = [
  { id: 'topology', label: 'Topology', icon: Network },
  { id: 'connections', label: 'Connections', icon: Boxes },
  { id: 'contract', label: 'Contract', icon: FileText },
  { id: 'feed', label: 'Live feed', icon: Radio },
]

const DEFAULT_URL = new URLSearchParams(window.location.search).get('url') ?? 'ws://localhost:3000'

function Json({ data }: { data: unknown }): React.JSX.Element {
  return (
    <pre className="max-h-[72vh] overflow-auto rounded-md border bg-background/40 p-3 text-xs leading-relaxed">
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}

function StatusDot({ status }: { status: InspectorStatus }): React.JSX.Element {
  const color =
    status === 'open' ? 'bg-primary' : status === 'connecting' ? 'bg-muted-foreground' : 'bg-destructive'
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span className={cn('h-2 w-2 rounded-full', color)} />
      {status}
    </span>
  )
}

export default function App(): React.JSX.Element {
  const [url, setUrl] = React.useState(DEFAULT_URL)
  const [draft, setDraft] = React.useState(DEFAULT_URL)
  const [view, setView] = React.useState<View>('topology')
  const { client, status } = useInspector(url)

  const [topology, setTopology] = React.useState<NodeStat[]>([])
  const [connections, setConnections] = React.useState<ConnDescriptor[]>([])
  const [contract, setContract] = React.useState<InspectedContract | null>(null)
  const [nodeView, setNodeView] = React.useState<NodeView | null>(null)
  const [feed, setFeed] = React.useState<InspectorEvent[]>([])
  const [highlightRoom, setHighlightRoom] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!client || status !== 'open') return
    let live = true
    const load = (): void => {
      Promise.all([
        client.getTopology(),
        client.listConnections(),
        client.getContract(),
        client.getNode(),
      ])
        .then(([t, conns, ct, nv]) => {
          if (!live) return
          setTopology(t)
          setConnections(conns)
          setContract(ct)
          setNodeView(nv)
        })
        .catch(() => {})
    }
    load()
    const off = client.onEvent((event) => {
      if (!live) return
      setFeed((prev) => [event, ...prev].slice(0, 200))
      load()
    })
    return () => {
      live = false
      off()
    }
  }, [client, status])

  const totalConns = topology.reduce((sum, n) => sum + n.connections, 0)
  const roles = React.useMemo(() => [...new Set(connections.map((c) => c.role))].sort(), [connections])
  const rooms = React.useMemo(() => roomsOf(connections), [connections])

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-card/40">
        <div className="flex items-center gap-2 px-4 py-4">
          <span className="h-2.5 w-2.5 rounded-full bg-primary" />
          <span className="text-sm font-semibold tracking-tight">Control Center</span>
        </div>
        <nav className="flex flex-col gap-1 px-2">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                view === item.id
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto px-4 py-3 text-[11px] text-muted-foreground">super-line · v1</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <form
            className="flex flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              setUrl(draft.trim())
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="ws://localhost:3000"
              className="h-9 w-full max-w-md rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <Button type="submit" size="sm" variant="secondary">
              Connect
            </Button>
          </form>
          <StatusDot status={status} />
          <Badge variant="muted">{topology.length} nodes</Badge>
          <Badge variant="muted">{totalConns} conns</Badge>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">
          {view === 'topology' ? (
            <div className="flex h-full">
              <div className="min-w-0 flex-1">
                <TopologyGraph
                  topology={topology}
                  connections={connections}
                  node={nodeView}
                  highlightRoom={highlightRoom}
                />
              </div>
              <RoomLens
                roles={roles}
                rooms={rooms}
                topics={nodeView?.topics ?? []}
                selected={highlightRoom}
                onSelect={setHighlightRoom}
              />
            </div>
          ) : (
            <div className="h-full overflow-auto p-4">
              {view === 'connections' && (
                <Card>
                  <CardHeader>
                    <CardTitle>Connections ({connections.length})</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Json data={connections} />
                  </CardContent>
                </Card>
              )}
              {view === 'contract' && (
                <Card>
                  <CardHeader>
                    <CardTitle>Contract</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {contract ? (
                      <Json data={contract} />
                    ) : (
                      <p className="text-sm text-muted-foreground">No contract.</p>
                    )}
                  </CardContent>
                </Card>
              )}
              {view === 'feed' && (
                <Card>
                  <CardHeader>
                    <CardTitle>Live feed ({feed.length})</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {feed.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Waiting for events…</p>
                    ) : (
                      <ul className="flex flex-col gap-1 text-xs">
                        {feed.map((event, i) => (
                          <li key={i} className="flex items-center gap-2 rounded-md border px-2 py-1">
                            <Badge>{event.type}</Badge>
                            <span className="truncate text-muted-foreground">{JSON.stringify(event)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
