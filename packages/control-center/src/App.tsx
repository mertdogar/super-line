import * as React from 'react'
import { Boxes, FileText, LibraryBig, Network, Radio, Settings, Table2 } from 'lucide-react'
import type {
  ConnDescriptor,
  InspectedContract,
  InspectorEnvelope,
  NodeStat,
  NodeView,
} from '@super-line/core'
import { useInspector } from '@/hooks/use-inspector'
import { Badge } from '@/components/ui/badge'
import { TopologyGraph } from '@/components/topology-graph'
import { RoomLens } from '@/components/room-lens'
import { ConnectionsTable } from '@/components/connections-table'
import { ConnDetail } from '@/components/conn-detail'
import { ContractExplorer } from '@/components/contract-explorer'
import { LiveFeed } from '@/components/live-feed'
import { CollectionsExplorer } from '@/components/collections-explorer'
import { SettingsPage } from '@/components/settings-page'
import { ResourcesPage } from '@/components/resources-page'
import { StatusDot } from '@/components/status-dot'
import { BrandMark } from '@/components/brand-mark'
import { version } from '../package.json'
import { roomsOf, type Highlight } from '@/lib/topology'
import { transportsOf } from '@/lib/transport'
import { cn } from '@/lib/utils'

type View = 'topology' | 'connections' | 'contract' | 'collections' | 'feed' | 'settings' | 'resources'
type NavItem = { id: View; label: string; icon: typeof Network }

const NAV: NavItem[] = [
  { id: 'topology', label: 'Topology', icon: Network },
  { id: 'connections', label: 'Connections', icon: Boxes },
  { id: 'contract', label: 'Contract', icon: FileText },
  { id: 'collections', label: 'Collections', icon: Table2 },
  { id: 'feed', label: 'Live feed', icon: Radio },
]
const NAV_BOTTOM: NavItem[] = [
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'resources', label: 'Resources', icon: LibraryBig },
]

const STORAGE_KEY = 'superline.cc.url'
const DEFAULT_URL = 'ws://localhost:3000'

function seedUrl(): string {
  // precedence: explicit ?url= deep-link → user's saved choice → launcher default → built-in default
  const fromQuery = new URLSearchParams(window.location.search).get('url')
  if (fromQuery) return fromQuery
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return stored
  } catch {
    /* localStorage may be unavailable (private mode) */
  }
  const injected = (window as { __CC_DEFAULT_URL__?: string }).__CC_DEFAULT_URL__
  if (injected) return injected
  return DEFAULT_URL
}

function NavButton({
  item,
  active,
  onClick,
}: {
  item: NavItem
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <item.icon className="h-4 w-4" />
      {item.label}
    </button>
  )
}

export default function App(): React.JSX.Element {
  const [url, setUrl] = React.useState(seedUrl)
  const [view, setView] = React.useState<View>('topology')
  const { client, status } = useInspector(url)

  const [topology, setTopology] = React.useState<NodeStat[]>([])
  const [connections, setConnections] = React.useState<ConnDescriptor[]>([])
  const [contract, setContract] = React.useState<InspectedContract | null>(null)
  const [nodeView, setNodeView] = React.useState<NodeView | null>(null)
  const [feed, setFeed] = React.useState<InspectorEnvelope[]>([])
  const [highlight, setHighlight] = React.useState<Highlight | null>(null)
  const [selectedConnId, setSelectedConnId] = React.useState<string | null>(null)

  const connect = React.useCallback((next: string) => {
    setUrl(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

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
  const transports = React.useMemo(() => transportsOf(connections), [connections])

  const active = [...NAV, ...NAV_BOTTOM].find((n) => n.id === view)
  const count =
    view === 'connections'
      ? `${connections.length} connections`
      : view === 'feed'
        ? `${feed.length} events`
        : ''

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-card/40">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <BrandMark status={status} />
          <div className="leading-none">
            <div className="text-[15px] font-bold tracking-tight">
              super-<span className="text-primary">line</span>
            </div>
            <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Control Center
            </div>
          </div>
        </div>
        <nav className="flex flex-col gap-1 px-2">
          {NAV.map((item) => (
            <NavButton key={item.id} item={item} active={view === item.id} onClick={() => setView(item.id)} />
          ))}
        </nav>
        <nav className="mt-auto flex flex-col gap-1 border-t px-2 py-2">
          {NAV_BOTTOM.map((item) => (
            <NavButton key={item.id} item={item} active={view === item.id} onClick={() => setView(item.id)} />
          ))}
        </nav>
        <div className="px-4 py-3 text-[11px] text-muted-foreground">v{version}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {active ? <active.icon className="h-4 w-4 text-muted-foreground" /> : null}
            {active?.label}
            {count ? <span className="text-xs font-normal text-muted-foreground">{count}</span> : null}
          </div>
          <div className="flex items-center gap-3">
            <StatusDot status={status} />
            <Badge variant="muted">{topology.length} nodes</Badge>
            <Badge variant="muted">{totalConns} conns</Badge>
          </div>
        </header>

        <main className="relative min-h-0 flex-1 overflow-hidden">
          {view === 'topology' ? (
            <div className="flex h-full">
              <div className="min-w-0 flex-1">
                <TopologyGraph
                  topology={topology}
                  connections={connections}
                  node={nodeView}
                  highlight={highlight}
                />
              </div>
              <RoomLens
                roles={roles}
                rooms={rooms}
                topics={nodeView?.topics ?? []}
                transports={transports}
                selected={highlight}
                onSelect={setHighlight}
              />
            </div>
          ) : (
            <div className="h-full overflow-auto p-4">
              {view === 'connections' && (
                <ConnectionsTable
                  connections={connections}
                  selectedId={selectedConnId}
                  onSelect={setSelectedConnId}
                />
              )}
              {view === 'contract' &&
                (contract ? (
                  <ContractExplorer contract={contract} />
                ) : (
                  <p className="text-sm text-muted-foreground">No contract.</p>
                ))}
              {view === 'collections' && <CollectionsExplorer client={client} />}
              {view === 'feed' && <LiveFeed events={feed} connections={connections} topology={topology} />}
              {view === 'settings' && <SettingsPage url={url} status={status} onConnect={connect} />}
              {view === 'resources' && <ResourcesPage />}
            </div>
          )}
          {view === 'connections' && (
            <ConnDetail client={client} connId={selectedConnId} onClose={() => setSelectedConnId(null)} />
          )}
        </main>
      </div>
    </div>
  )
}
