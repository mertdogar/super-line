import * as React from 'react'
import { Blocks, Boxes, FileText, Keyboard, LibraryBig, ListTodo, Network, Radio, Settings, Table2, TriangleAlert, X } from 'lucide-react'
import type {
  ConnDescriptor,
  InspectedContract,
  InspectorEnvelope,
  NodeStat,
  NodeView,
} from '@super-line/core'
import { useInspector, type InspectorCredentials } from '@/hooks/use-inspector'
import { useDirectory } from '@/hooks/use-directory'
import { Badge } from '@/components/ui/badge'
import { TopologyGraph } from '@/components/topology-graph'
import { RoomLens } from '@/components/room-lens'
import { ConnectionsTable } from '@/components/connections-table'
import { ConnDetail } from '@/components/conn-detail'
import { NodeDetail } from '@/components/node-detail'
import { ContractExplorer } from '@/components/contract-explorer'
import { LiveFeed } from '@/components/live-feed'
import { CollectionsExplorer } from '@/components/collections-explorer'
import { SettingsPage } from '@/components/settings-page'
import { ResourcesPage } from '@/components/resources-page'
import { PluginsPage } from '@/components/plugins-page'
import { StatusDot } from '@/components/status-dot'
import { BrandMark } from '@/components/brand-mark'
import { ConnectionState } from '@/components/connection-state'
import { QueuesPage } from '@/components/queues-page'
import { queueLensActive } from '@/lib/queue'
import { version } from '../package.json'
import { roomsOf, type Highlight } from '@/lib/topology'
import { connectedUsers } from '@/lib/identity'
import { transportsOf } from '@/lib/transport'
import { cn, plural } from '@/lib/utils'

type View = 'topology' | 'connections' | 'contract' | 'plugins' | 'collections' | 'feed' | 'settings' | 'resources' | 'queues'
type NavItem = { id: View; label: string; icon: typeof Network }

const NAV: NavItem[] = [
  { id: 'topology', label: 'Topology', icon: Network },
  { id: 'contract', label: 'Contract', icon: FileText },
  { id: 'collections', label: 'Collections', icon: Table2 },
  { id: 'queues', label: 'Queues', icon: ListTodo },
  { id: 'connections', label: 'Connections', icon: Boxes },
  { id: 'feed', label: 'Live feed', icon: Radio },
  { id: 'plugins', label: 'Plugins', icon: Blocks },
]
const NAV_BOTTOM: NavItem[] = [
  { id: 'settings', label: 'Settings', icon: Settings },
  { id: 'resources', label: 'Resources', icon: LibraryBig },
]

const STORAGE_KEY = 'superline.cc.url'
// Credentials persist under their OWN keys, never folded into the URL string — the URL is displayed in
// Settings, echoed by the launcher, and shareable as a ?url= deep link. A password must be in none of those.
const USER_KEY = 'superline.cc.user'
const PASSWORD_KEY = 'superline.cc.password'
const DEFAULT_URL = 'ws://localhost:3000'

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null // localStorage may be unavailable (private mode)
  }
}

function writeStored(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

function seedUrl(): string {
  // precedence: explicit ?url= deep-link → user's saved choice → launcher default → built-in default
  const fromQuery = new URLSearchParams(window.location.search).get('url')
  if (fromQuery) return fromQuery
  const stored = readStored(STORAGE_KEY)
  if (stored) return stored
  const injected = (window as { __CC_DEFAULT_URL__?: string }).__CC_DEFAULT_URL__
  if (injected) return injected
  return DEFAULT_URL
}

function seedCredentials(): InspectorCredentials {
  return { user: readStored(USER_KEY) ?? '', password: readStored(PASSWORD_KEY) ?? '' }
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
    <button type="button"
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
  const [credentials, setCredentials] = React.useState(seedCredentials)
  const [view, setView] = React.useState<View>('topology')
  const [reconnect, setReconnect] = React.useState(0)
  const { client, status, authReason } = useInspector(url, credentials, reconnect)

  const [topology, setTopology] = React.useState<NodeStat[]>([])
  const [connections, setConnections] = React.useState<ConnDescriptor[]>([])
  const [contract, setContract] = React.useState<InspectedContract | null>(null)
  const [nodeView, setNodeView] = React.useState<NodeView | null>(null)
  const [feed, setFeed] = React.useState<InspectorEnvelope[]>([])
  const [highlight, setHighlight] = React.useState<Highlight | null>(null)
  const [selectedConnId, setSelectedConnId] = React.useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [ready, setReady] = React.useState(false)
  const [showShortcuts, setShowShortcuts] = React.useState(false)

  const connect = React.useCallback((next: string, nextCredentials: InspectorCredentials) => {
    setUrl(next)
    setCredentials(nextCredentials)
    writeStored(STORAGE_KEY, next)
    writeStored(USER_KEY, nextCredentials.user)
    writeStored(PASSWORD_KEY, nextCredentials.password)
  }, [])

  // Topology node selection: a conn opens the shared ConnDetail panel; a server opens NodeDetail. Only one
  // detail is ever open, and the bus node (clusters only) has nothing to inspect.
  const onTopoSelect = React.useCallback((sel: { id: string; kind: 'bus' | 'server' | 'conn' } | null) => {
    if (!sel || sel.kind === 'bus') {
      setSelectedConnId(null)
      setSelectedNodeId(null)
      return
    }
    if (sel.kind === 'conn') {
      setSelectedNodeId(null)
      setSelectedConnId(sel.id)
    } else {
      setSelectedConnId(null)
      setSelectedNodeId(sel.id)
    }
  }, [])

  // Not connected ⇒ we haven't loaded, so the empty state reads "connecting/closed" not "0 nodes".
  React.useEffect(() => {
    if (status !== 'open') setReady(false)
  }, [status])

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
          setLoadError(null)
          setReady(true)
        })
        // in a DEBUGGING tool, a silently-swallowed load error reads as "the cluster is empty" — surface it
        .catch((e: unknown) => {
          if (live) setLoadError(e instanceof Error ? e.message : String(e))
        })
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

  // Keyboard: digits switch views, `/` focuses the filter, `?` toggles the shortcuts sheet, Esc closes it.
  // Ignored while typing or inside a dialog (the detail panels own Esc / Tab there).
  React.useEffect(() => {
    const all = [...NAV, ...NAV_BOTTOM]
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setShowShortcuts(false)
        return
      }
      const t = e.target
      if (t instanceof HTMLElement && t.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '?') {
        e.preventDefault()
        setShowShortcuts((v) => !v)
        return
      }
      if (e.key === '/') {
        const input = document.querySelector<HTMLInputElement>('main input:not([type="range"])')
        if (input) {
          e.preventDefault()
          input.focus()
        }
        return
      }
      const n = Number(e.key)
      if (n >= 1 && n <= all.length) setView(all[n - 1]!.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Re-render on a slow cadence so relative "· 3m ago" durations keep ticking on an idle feed.
  const [, tickNow] = React.useState(0)
  React.useEffect(() => {
    const id = setInterval(() => tickNow((n) => n + 1), 15_000)
    return () => clearInterval(id)
  }, [])

  const directory = useDirectory(client, contract, connections)
  const users = React.useMemo(() => connectedUsers(connections, directory), [connections, directory])

  const totalConns = topology.reduce((sum, n) => sum + n.connections, 0)
  const roles = React.useMemo(() => [...new Set(connections.map((c) => c.role))].sort(), [connections])
  const rooms = React.useMemo(() => roomsOf(connections), [connections])
  const transports = React.useMemo(() => transportsOf(connections), [connections])

  const active = [...NAV, ...NAV_BOTTOM].find((n) => n.id === view)
  const count =
    view === 'connections'
      ? plural(connections.length, 'connection')
      : view === 'feed'
        ? plural(feed.length, 'event')
        : ''

  // Settings/Resources need no connection; the data views show a diagnostic state until a node reports.
  const isDataView = view !== 'settings' && view !== 'resources'
  const showState = isDataView && (status !== 'open' || (ready && topology.length === 0 && !nodeView))

  const activeNav = React.useMemo(
    () => (queueLensActive(contract) ? NAV : NAV.filter((n) => n.id !== 'queues')),
    [contract],
  )

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
          {activeNav.map((item) => (
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
            <Badge variant="muted">{plural(topology.length, 'node')}</Badge>
            <Badge variant="muted">{plural(totalConns, 'conn')}</Badge>
          </div>
        </header>

        <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {loadError && isDataView && !showState ? (
            <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Inspector request failed — {loadError}</span>
              <button
                type="button"
                onClick={() => setReconnect((n) => n + 1)}
                className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => setLoadError(null)}
                aria-label="Dismiss error"
                className="shrink-0 rounded p-0.5 hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          {showState ? (
            <ConnectionState
              status={status}
              url={url}
              authReason={authReason}
              onRetry={() => setReconnect((n) => n + 1)}
              onOpenSettings={() => setView('settings')}
            />
          ) : view === 'topology' ? (
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1">
                <TopologyGraph
                  topology={topology}
                  connections={connections}
                  node={nodeView}
                  highlight={highlight}
                  directory={directory}
                  selectedId={selectedConnId ?? selectedNodeId}
                  onSelect={onTopoSelect}
                />
              </div>
              <RoomLens
                roles={roles}
                rooms={rooms}
                topics={nodeView?.topics ?? []}
                transports={transports}
                users={users}
                selected={highlight}
                onSelect={setHighlight}
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {view === 'connections' && (
                <ConnectionsTable
                  connections={connections}
                  directory={directory}
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
              {view === 'plugins' && <PluginsPage contract={contract} />}
              {view === 'collections' && <CollectionsExplorer client={client} contract={contract} />}
              {view === 'feed' && <LiveFeed events={feed} connections={connections} topology={topology} />}
              {view === 'queues' && <QueuesPage client={client} />}
              {view === 'settings' && (
                <SettingsPage
                  url={url}
                  credentials={credentials}
                  status={status}
                  authReason={authReason}
                  onConnect={connect}
                />
              )}
              {view === 'resources' && <ResourcesPage />}
            </div>
          )}

          {!showState && (view === 'connections' || view === 'topology') && (
            <ConnDetail
              client={client}
              connId={selectedConnId}
              directory={directory}
              onClose={() => setSelectedConnId(null)}
            />
          )}
          {!showState && view === 'topology' && (
            <NodeDetail
              nodeId={selectedNodeId}
              topology={topology}
              node={nodeView}
              connections={connections}
              directory={directory}
              onClose={() => setSelectedNodeId(null)}
              onSelectConn={(id) => {
                setSelectedNodeId(null)
                setSelectedConnId(id)
              }}
            />
          )}
        </main>
      </div>
      {showShortcuts ? <ShortcutsSheet onClose={() => setShowShortcuts(false)} /> : null}
    </div>
  )
}

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: '1–8', label: 'Switch view (Topology → Resources)' },
  { keys: '/', label: 'Focus the filter' },
  { keys: 'Esc', label: 'Close a panel or this sheet' },
  { keys: '?', label: 'Toggle this sheet' },
]

function ShortcutsSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  // This one IS modal — trap Tab inside it and restore focus to the opener on close (Esc closes it via App).
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const els = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((el) => el.offsetParent !== null)
      if (els.length === 0) {
        e.preventDefault()
        ref.current?.focus()
        return
      }
      const first = els[0]!
      const last = els[els.length - 1]!
      const active = document.activeElement as HTMLElement
      if (e.shiftKey && (active === first || !ref.current?.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus?.()
    }
  }, [])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-lg outline-none"
      >
        <div className="mb-3 flex items-center gap-2">
          <Keyboard className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
        </div>
        <dl className="flex flex-col gap-1.5">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center justify-between gap-3 text-sm">
              <dt className="text-muted-foreground">{s.label}</dt>
              <dd className="shrink-0 rounded border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px]">{s.keys}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
