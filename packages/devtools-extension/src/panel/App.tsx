import * as React from 'react'
import { NOT_INSTALLED, drain } from '../lib/bridge.js'
import { downloadExport, exportRows, EXPORT_FORMATS, type ExportFormat } from '../lib/export.js'
import { CATEGORIES, type Category } from '../lib/labels.js'
import { applyOpFilter, toOperations } from '../lib/operations.js'
import {
  applyBatch,
  applyFilter,
  applyPushed,
  initialState,
  SUPPORTED_TAP_VERSION,
  type Filter,
  type PanelState,
} from '../lib/reduce.js'
import { connectPushPort, injectRelay, isGranted, requestPush, revokePush } from '../lib/push.js'
import { Activity } from './Activity.js'
import { Timeline } from './Timeline.js'
import { StateRail } from './StateRail.js'
import { Inspectors } from './Inspectors.js'
import { useStored } from './useStored.js'

const POLL_MS = 200
type Mode = 'activity' | 'frames'

export function App(): React.JSX.Element {
  const [state, setState] = React.useState<PanelState>(initialState)
  const [installed, setInstalled] = React.useState<boolean | undefined>(undefined)
  const [paused, setPaused] = React.useState(false)
  const [preserve, setPreserve] = React.useState(true)
  const [filter, setFilter] = React.useState<Filter>({})
  const [selected, setSelected] = React.useState<number | undefined>(undefined)
  const [mode, setMode] = useStored<Mode>('mode', 'activity')

  // layout, persisted so the panel opens the way you left it (localStorage is synchronous in an
  // extension page, so there is no flash of the wrong width)
  const [railWidth, setRailWidth] = useStored('railWidth', 384)
  const [railOpen, setRailOpen] = useStored('railOpen', true)

  const cursor = React.useRef(0)
  const preserveRef = React.useRef(preserve)
  preserveRef.current = preserve

  React.useEffect(() => {
    if (paused) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      const batch = await drain(cursor.current)
      if (cancelled) return
      if (batch === NOT_INSTALLED) return setInstalled(false)
      if (!batch) return
      setInstalled(true)
      cursor.current = batch.cursor
      setState((prev) => applyBatch(prev, batch, preserveRef.current))
      if (batch.more && !cancelled) void tick()
    }
    void tick()
    const timer = setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [paused])

  const [pushOn, setPushOn] = React.useState(false)
  React.useEffect(() => {
    void isGranted().then(setPushOn)
  }, [])

  React.useEffect(() => {
    if (!pushOn || paused) return
    const tabId = chrome.devtools.inspectedWindow.tabId
    let disconnect: (() => void) | undefined
    void injectRelay(tabId)
      .then(() => {
        disconnect = connectPushPort(tabId, (record) => {
          setState((prev) => applyPushed(prev, record, preserveRef.current) ?? prev)
        })
      })
      .catch(() => setPushOn(false))
    return () => disconnect?.()
  }, [pushOn, paused])

  React.useEffect(() => {
    if (state.cursor > cursor.current) cursor.current = state.cursor
  }, [state.cursor])

  const togglePush = async (): Promise<void> => {
    if (pushOn) {
      await revokePush()
      return setPushOn(false)
    }
    setPushOn(await requestPush())
  }

  // The fold runs over EVERYTHING, then the filter runs over operations. Folding a filtered stream
  // would strand every request whose response the filter removed, leaving rows pending forever.
  const ops = React.useMemo(() => toOperations(state.entries), [state.entries])
  const visibleOps = React.useMemo(() => applyOpFilter(ops, filter), [ops, filter])
  const visibleFrames = React.useMemo(() => applyFilter(state.entries, filter), [state.entries, filter])

  /** Correlation key → the label of the request it answers, so a `res` row can name itself. */
  const answers = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const entry of ops) {
      // keyed off the operation's own correlation id, not its first record: a request that waited for
      // a writable socket starts with `req.queued`, which is not a frame and carries no id
      if (entry.type === 'op' && entry.corr !== undefined) map.set(`${entry.clientId}#${entry.corr}`, entry.label)
    }
    return map
  }, [ops])

  const shown = mode === 'activity' ? visibleOps : visibleFrames
  const shownCount = shown.filter((e) => e.type !== 'divider').length
  const totalCount = (mode === 'activity' ? ops : state.entries).filter((e) => e.type !== 'divider').length

  const selectedRecords = React.useMemo(() => {
    if (selected === undefined) return undefined
    const op = ops.find((e) => e.type === 'op' && e.seq === selected)
    if (op && op.type === 'op') return op.records
    const row = state.entries.find((e) => e.type === 'row' && e.seq === selected)
    return row && row.type === 'row'
      ? [{ event: row.event, seq: row.seq, ts: row.ts, clientId: row.clientId }]
      : undefined
  }, [selected, ops, state.entries])

  const doExport = (format: ExportFormat): void => {
    downloadExport(exportRows(visibleFrames, visibleOps, mode), format, {
      mode,
      pageLoadId: state.pageLoadId,
      panelVersion: __PANEL_VERSION__,
      tapVersion: SUPPORTED_TAP_VERSION,
      filter,
      now: Date.now(),
    })
  }

  if (installed === false) return <NotInstalled />

  return (
    <div className="flex h-full flex-col">
      {state.versionWarning && (
        <div className="border-b border-[var(--color-line)] bg-[var(--color-warn)]/15 px-3 py-1.5 text-[var(--color-warn)]">
          {state.versionWarning}
        </div>
      )}

      <Toolbar
        mode={mode}
        setMode={setMode}
        paused={paused}
        onPause={() => setPaused((p) => !p)}
        preserve={preserve}
        onPreserve={() => setPreserve((p) => !p)}
        onClear={() => {
          setState((prev) => ({ ...initialState(), pageLoadId: prev.pageLoadId }))
          setSelected(undefined)
        }}
        pushOn={pushOn}
        onTogglePush={() => void togglePush()}
        filter={filter}
        setFilter={setFilter}
        clients={state.clients}
        shown={shownCount}
        total={totalCount}
        dropped={state.droppedTotal}
        onExport={doExport}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen(!railOpen)}
      />

      <div className="flex min-h-0 flex-1">
        {mode === 'activity' ? (
          <Activity entries={visibleOps} selected={selected} onSelect={setSelected} />
        ) : (
          <Timeline entries={visibleFrames} answers={answers} selected={selected} onSelect={setSelected} />
        )}

        {railOpen && (
          <>
            <Resizer width={railWidth} onWidth={setRailWidth} />
            <div
              className="flex shrink-0 flex-col border-l border-[var(--color-line)]"
              style={{ width: railWidth }}
            >
              <StateRail state={state} />
              <Inspectors state={state} records={selectedRecords} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Drag handle. Widened beyond its visual line so it is actually grabbable. */
function Resizer({ width, onWidth }: { width: number; onWidth(w: number): void }): React.JSX.Element {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    const move = (ev: PointerEvent): void => {
      const next = startWidth - (ev.clientX - startX)
      onWidth(Math.max(240, Math.min(next, window.innerWidth - 320)))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-[var(--color-accent)]"
    />
  )
}

function NotInstalled(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md space-y-3">
        <h1 className="text-sm font-semibold">No super-line client is reporting on this page.</h1>
        <p className="text-[var(--color-muted)]">
          This panel reads a client that opts in. Add the devtools plugin where the client is created:
        </p>
        <pre className="overflow-auto rounded border border-[var(--color-line)] bg-[var(--color-panel)] p-3 text-[11px] leading-relaxed">
          {`import { devtoolsPlugin } from '@super-line/plugin-devtools'

const client = createSuperLineClient(api, {
  transport, role: 'user',
  plugins: [devtoolsPlugin()],
})`}
        </pre>
        <p className="text-[var(--color-muted)]">
          Then reload the page. Nothing is observed or buffered until the plugin is present.
        </p>
      </div>
    </div>
  )
}

interface ToolbarProps {
  mode: Mode
  setMode(m: Mode): void
  paused: boolean
  onPause(): void
  preserve: boolean
  onPreserve(): void
  onClear(): void
  pushOn: boolean
  onTogglePush(): void
  filter: Filter
  setFilter(f: Filter): void
  clients: PanelState['clients']
  shown: number
  total: number
  dropped: number
  onExport(format: ExportFormat): void
  railOpen: boolean
  onToggleRail(): void
}

function Toolbar(p: ToolbarProps): React.JSX.Element {
  const toggle = <T,>(list: T[] | undefined, value: T): T[] => {
    const set = new Set(list ?? [])
    if (set.has(value)) set.delete(value)
    else set.add(value)
    return [...set]
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-2 py-1.5">
      <div className="flex overflow-hidden rounded border border-[var(--color-line)]">
        {(['activity', 'frames'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => p.setMode(m)}
            className={`px-2 py-0.5 ${
              p.mode === m ? 'bg-[var(--color-accent)] text-[var(--color-bg)]' : 'text-[var(--color-muted)]'
            }`}
            title={m === 'activity' ? 'One row per operation' : 'One row per wire frame'}
          >
            {m === 'activity' ? 'Activity' : 'Frames'}
          </button>
        ))}
      </div>

      <button type="button" onClick={p.onPause} className={btn(p.paused)}>
        {p.paused ? 'Resume' : 'Pause'}
      </button>
      <button type="button" onClick={p.onClear} className={btn(false)}>
        Clear
      </button>
      <label className="flex items-center gap-1 text-[var(--color-muted)]">
        <input type="checkbox" checked={p.preserve} onChange={p.onPreserve} />
        Preserve
      </label>
      <label className="flex items-center gap-1 text-[var(--color-muted)]" title="ping/pong — never the bug">
        <input
          type="checkbox"
          checked={p.filter.heartbeat ?? false}
          onChange={() => p.setFilter({ ...p.filter, heartbeat: !p.filter.heartbeat })}
        />
        Heartbeat
      </label>
      <button
        type="button"
        onClick={p.onTogglePush}
        className={btn(p.pushOn)}
        title={
          p.pushOn
            ? 'Live push is on for this origin. Click to revoke.'
            : 'Polling every 200ms. Grant this origin to receive events as they happen.'
        }
      >
        {p.pushOn ? 'Live' : 'Polling'}
      </button>

      <input
        value={p.filter.text ?? ''}
        onChange={(e) => p.setFilter({ ...p.filter, text: e.target.value })}
        placeholder="Filter"
        className="w-36 rounded border border-[var(--color-line)] bg-transparent px-2 py-0.5"
      />

      <div className="flex items-center gap-1">
        {CATEGORIES.filter((c) => c !== 'heartbeat').map((c: Category) => (
          <button
            key={c}
            type="button"
            onClick={() => p.setFilter({ ...p.filter, categories: toggle(p.filter.categories, c) })}
            className={btn(p.filter.categories?.includes(c) ?? false)}
          >
            {c}
          </button>
        ))}
        <button
          type="button"
          onClick={() => p.setFilter({ ...p.filter, problemsOnly: !p.filter.problemsOnly })}
          className={`rounded border px-1.5 py-0.5 ${
            p.filter.problemsOnly
              ? 'border-[var(--color-bad)] text-[var(--color-bad)]'
              : 'border-[var(--color-line)] text-[var(--color-muted)]'
          }`}
          title="Failures, timeouts, rejected payloads, deliveries with no listener — across every category"
        >
          ⚠ problems
        </button>
      </div>

      {p.clients.length > 1 && (
        <div className="flex items-center gap-1">
          {p.clients.map((c) => (
            <button
              key={c.clientId}
              type="button"
              onClick={() => p.setFilter({ ...p.filter, clientIds: toggle(p.filter.clientIds, c.clientId) })}
              className={btn(p.filter.clientIds?.includes(c.clientId) ?? false)}
              title={`${c.role} · ${c.alive ? 'live' : 'closed'}`}
            >
              {c.alive ? '●' : '†'} {c.role}
            </button>
          ))}
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        {/* nothing auto-updates this panel and the wire-version banner only fires on a protocol
            change, so the build has to name itself or a stale one is invisible */}
        <span
          className="tabular text-[var(--color-muted)] opacity-60"
          title={`super-line devtools ${__PANEL_VERSION__} — this panel does not auto-update; compare against the Releases page`}
        >
          v{__PANEL_VERSION__}
        </span>
        <span className="tabular text-[var(--color-muted)]">
          {p.shown === p.total ? `${p.total}` : `${p.shown} / ${p.total}`}
          {p.dropped > 0 && <span className="ml-2 text-[var(--color-warn)]">{p.dropped} dropped</span>}
        </span>
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) p.onExport(e.target.value as ExportFormat)
            e.target.value = ''
          }}
          className="rounded border border-[var(--color-line)] bg-transparent px-1 py-0.5 text-[var(--color-muted)]"
          title="Download the filtered rows you are looking at"
        >
          <option value="">↓ export</option>
          {EXPORT_FORMATS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={p.onToggleRail}
          className={btn(false)}
          title={p.railOpen ? 'Hide the side panel' : 'Show the side panel'}
        >
          {p.railOpen ? '▨' : '▧'}
        </button>
      </div>
    </div>
  )
}

const btn = (active: boolean): string =>
  `rounded border px-1.5 py-0.5 ${
    active
      ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
      : 'border-[var(--color-line)] text-[var(--color-muted)]'
  }`
