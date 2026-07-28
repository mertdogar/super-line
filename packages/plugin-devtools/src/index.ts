/**
 * The client half of super-line's DevTools story (ADR-0024): a client plugin that taps the client and
 * parks what it sees in a page-global buffer for the DevTools panel to drain.
 *
 * The buffer is page-global rather than per-plugin on purpose. A page routinely runs several clients —
 * a session replacement builds its candidate and confirms it BEFORE closing the incumbent — so a
 * per-instance buffer would reset the log on every sign-in, discarding exactly the handover a reader
 * wants to inspect. One buffer, one monotonic sequence, every record tagged with its client.
 */

import { safeSnapshot, type ClientTapEvent, type ClientTapRecord, type Frame } from '@super-line/core'
import type {
  ClientPluginContext,
  CollectionSubView,
  OpenDocView,
  PendingRequestView,
  SuperLineClientPlugin,
  TopicSubView,
} from '@super-line/client'

/** Where the registry parks itself on the page. */
export const DEVTOOLS_GLOBAL = '__SUPER_LINE_DEVTOOLS__'

/**
 * The shape of what a client emits and the registry serves. A panel built against an older version may
 * not understand newer records, so it compares this and says so rather than rendering nonsense.
 */
export const TAP_VERSION = 1

/** Default ring capacity. Beyond this the oldest records are evicted and counted, never silently dropped. */
const DEFAULT_MAX_EVENTS = 5000
/** Default per-drain ceiling, so one drain after a long pause cannot return a batch too large to marshal. */
const DEFAULT_DRAIN_LIMIT = 2000

export interface DevtoolsPluginOptions {
  /** Ring capacity. Oldest-first eviction past this; the count of evicted records is reported to the reader. */
  maxEvents?: number
  /**
   * Field names masked at every depth before a payload enters the buffer. The buffer lives in the
   * page's own memory, so this is about what ends up in a screenshot rather than about access control.
   */
  redact?: string[]
}

/** One client the page has built, alive or not. */
export interface ClientSummary {
  clientId: string
  role: string
  /** `false` once `client.close()` has run. Dead clients stay listed so their history still reads. */
  alive: boolean
}

/** What one `drain` call returns. Every field is JSON-compliant — the panel's channel accepts nothing else. */
export interface DrainBatch {
  tapVersion: number
  /** Changes on every page load, so a reader can tell a reload from a gap in the sequence. */
  pageLoadId: string
  records: ClientTapRecord[]
  /** The highest sequence in this batch, to pass back as the next cursor. */
  cursor: number
  /** Records evicted before this reader reached them. Rendered as a visible gap, never swallowed. */
  dropped: number
  /** True when the ring still holds records past this batch's limit — drain again immediately. */
  more: boolean
  clients: ClientSummary[]
}

/** A client's current state, pulled on demand rather than streamed. */
export interface ClientStateSnapshot {
  clientId: string
  role: string
  alive: boolean
  pending: PendingRequestView[]
  topics: TopicSubView[]
  collections: CollectionSubView[]
  /** Document identity and replica counts only; contents come from `docSnapshot`, which is the expensive call. */
  docs: OpenDocView[]
}

/** What the panel talks to. Installed on `globalThis` by whichever plugin instance runs first. */
export interface DevtoolsRegistry {
  readonly tapVersion: number
  readonly pageLoadId: string
  /** Everything after `cursor`, capped at `limit`. */
  drain(cursor: number, limit?: number): DrainBatch
  clients(): ClientSummary[]
  /** Current state of one client, or `undefined` if it never existed. */
  inspect(clientId: string): ClientStateSnapshot | undefined
  /** Plaintext contents of one open CRDT document — the wire carries only opaque deltas. */
  docSnapshot(clientId: string, n: string, id: string): unknown
}

interface Registered {
  ctx: ClientPluginContext
  alive: boolean
}

interface RegistryInternals extends DevtoolsRegistry {
  /**
   * @internal Notified as each record lands, so a reader can be pushed to instead of polling. Used by the
   * DevTools extension's injected relay; without it a "push" path would just be a second poll loop.
   */
  __subscribe(cb: (record: ClientTapRecord) => void): () => void
  /** @internal — the plugin's own write path into the shared buffer. */
  __record(clientId: string, event: ClientTapEvent, redact: ReadonlySet<string> | undefined): void
  /** @internal */
  __register(ctx: ClientPluginContext): void
  /** @internal */
  __retire(clientId: string): void
  /** @internal */
  __maxEvents: number
}

// A random page-load id rather than a timestamp: two loads inside the same millisecond are ordinary
// during development, and a reader uses this only to tell "different load" from "same load".
const randomId = (): string => Math.random().toString(36).slice(2, 10)

function createRegistry(maxEvents: number): RegistryInternals {
  const buf: ClientTapRecord[] = []
  const registered = new Map<string, Registered>()
  const order: string[] = [] // registration order, so the panel lists clients as the page built them
  const listeners = new Set<(record: ClientTapRecord) => void>()
  let seq = 0
  let evictedThrough = 0 // highest sequence dropped from the front of the ring
  const pageLoadId = randomId()

  // Trim in chunks rather than on every push: shifting one element per event is O(n) forever, while
  // letting the ring run 25% over and then splicing once is amortized constant.
  const trimAt = Math.max(1, Math.floor(maxEvents * 1.25))
  const trim = (): void => {
    if (buf.length <= trimAt) return
    const excess = buf.length - maxEvents
    evictedThrough = buf[excess - 1]!.seq
    buf.splice(0, excess)
  }

  /** Index of the first record with `seq > cursor`. The buffer is sorted by construction, so binary search. */
  const firstAfter = (cursor: number): number => {
    let lo = 0
    let hi = buf.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (buf[mid]!.seq > cursor) hi = mid
      else lo = mid + 1
    }
    return lo
  }

  const summaries = (): ClientSummary[] =>
    order.map((clientId) => {
      const entry = registered.get(clientId)!
      return { clientId, role: entry.ctx.role, alive: entry.alive }
    })

  return {
    tapVersion: TAP_VERSION,
    pageLoadId,
    __maxEvents: maxEvents,
    __register(ctx) {
      if (registered.has(ctx.clientId)) return
      registered.set(ctx.clientId, { ctx, alive: true })
      order.push(ctx.clientId)
    },
    __retire(clientId) {
      const entry = registered.get(clientId)
      if (entry) entry.alive = false // kept, not deleted: its records are still in the buffer
    },
    __subscribe(cb) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    __record(clientId, event, redact) {
      // Snapshot HERE, at emit. The frame holds live references to app payloads, and the panel's channel
      // throws on the whole batch — not the offending row — if anything in it is not JSON-compliant.
      const snapshotted: ClientTapEvent =
        event.k === 'frame' ? { ...event, f: safeSnapshot(event.f, redact) as Frame } : event
      const record: ClientTapRecord = { event: snapshotted, seq: ++seq, ts: Date.now(), clientId }
      buf.push(record)
      trim()
      // A listener that throws must not take the app down with it — the record is already buffered, so
      // the polling reader still gets it.
      for (const cb of listeners) {
        try {
          cb(record)
        } catch {
          // observers do not get to fail the thing they observe
        }
      }
    },
    drain(cursor, limit = DEFAULT_DRAIN_LIMIT) {
      const start = firstAfter(cursor)
      const available = buf.length - start
      const take = Math.min(available, Math.max(1, limit))
      const records = buf.slice(start, start + take)
      return {
        tapVersion: TAP_VERSION,
        pageLoadId,
        records,
        cursor: records.length ? records[records.length - 1]!.seq : cursor,
        // Everything between where this reader was and the oldest record still held is gone. Reporting
        // it is the difference between a visible gap and a log that quietly lies about being complete.
        dropped: Math.max(0, evictedThrough - cursor),
        more: available > take,
        clients: summaries(),
      }
    },
    clients: summaries,
    inspect(clientId) {
      const entry = registered.get(clientId)
      if (!entry) return undefined
      const { ctx } = entry
      return {
        clientId,
        role: ctx.role,
        alive: entry.alive,
        pending: ctx.getPending(),
        topics: ctx.getTopics(),
        // rows are app data heading for a JSON-only channel
        collections: ctx.getCollectionSubs().map((s) => ({
          ...s,
          query: safeSnapshot(s.query) as CollectionSubView['query'],
          rows: safeSnapshot(s.rows) as unknown[],
        })),
        docs: ctx.getOpenDocs(),
      }
    },
    docSnapshot(clientId, n, id) {
      return safeSnapshot(registered.get(clientId)?.ctx.getDocSnapshot(n, id))
    },
  }
}

/** Install-or-adopt: the first plugin instance on the page creates the registry, the rest share it. */
function registryFor(maxEvents: number): RegistryInternals {
  const host = globalThis as Record<string, unknown>
  const existing = host[DEVTOOLS_GLOBAL] as RegistryInternals | undefined
  if (existing) return existing
  const created = createRegistry(maxEvents)
  host[DEVTOOLS_GLOBAL] = created
  return created
}

/**
 * Buffer this client's frames and client-local decisions for the super-line DevTools panel.
 *
 * ```ts
 * const client = createSuperLineClient(api, {
 *   transport: webSocketClientTransport({ url }),
 *   role: 'user',
 *   plugins: [devtoolsPlugin()],
 * })
 * ```
 *
 * Opt-in on purpose: nothing is observed, buffered or exposed unless an app names this plugin. Payloads
 * are snapshotted as they arrive, so the buffer never pins an app object alive or shows one that has
 * since been mutated.
 */
export function devtoolsPlugin(opts: DevtoolsPluginOptions = {}): SuperLineClientPlugin {
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS
  const redact = opts.redact?.length ? new Set(opts.redact) : undefined
  const registry = registryFor(maxEvents)
  let clientId = ''

  return {
    name: 'devtools',
    setup(ctx) {
      clientId = ctx.clientId
      registry.__register(ctx)
      return () => registry.__retire(ctx.clientId)
    },
    onClientSideEvent(event) {
      registry.__record(clientId, event, redact)
    },
  }
}

/** The registry on this page, if any plugin instance has installed one. Mainly for tests. */
export function devtoolsRegistry(): DevtoolsRegistry | undefined {
  return (globalThis as Record<string, unknown>)[DEVTOOLS_GLOBAL] as DevtoolsRegistry | undefined
}
