import { createRequire } from 'node:module'
import * as z from 'zod'
import { defineContractPlugin } from '@super-line/core'
import type { PluginContext, ServerCollectionHandle, SuperLinePlugin } from '@super-line/server'
import type {
  ActivityContext,
  Client as DuroxideClient,
  OrchestrationContext,
  PostgresProvider,
  Runtime as DuroxideRuntime,
  SqliteProvider,
} from 'duroxide'

export const WORKFLOW_RUNS = 'workflowRuns'

export const workflowRunSchema = z.object({
  id: z.string(),
  kind: z.enum(['workflow', 'job']),
  name: z.string(),
  // kept loose on purpose: an unknown engine status must degrade to an odd row, not a validation
  // error that kills the projection watcher
  status: z.string(),
  customStatus: z.string().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type WorkflowRun = z.infer<typeof workflowRunSchema>

/** Terminal snapshot mirrored from duroxide (`output`/`error` are the engine's JSON-encoded strings). */
export interface WorkflowStatus {
  status: string
  output?: string
  error?: string
  customStatus?: string
}

export type WorkflowProvider = PostgresProvider | SqliteProvider

export interface ActivityRunContext {
  readonly signal: AbortSignal
}

export type WorkflowActivity = (input: any, ctx: ActivityRunContext) => unknown | Promise<unknown>
/** A duroxide orchestration: a generator that `yield`s scheduled tasks — never an async function. */
export type WorkflowOrchestration = (ctx: OrchestrationContext, input: any) => Generator

export interface WorkflowQueueDefinition {
  worker: WorkflowActivity
  maxAttempts?: number
  timeoutMs?: number
}

export interface WorkflowsOptions {
  /** An already-connected provider: `PostgresProvider.connectWithSchema(url, schema)` or `SqliteProvider.open(path)`. */
  provider: WorkflowProvider
  activities?: Record<string, WorkflowActivity>
  workflows?: Record<string, WorkflowOrchestration>
  queues?: Record<string, WorkflowQueueDefinition>
  /** Lifecycle-projection poll cadence per live instance. Defaults to 300ms. */
  pollIntervalMs?: number
  /** How often a running activity checks for cancellation to fire its AbortSignal. Defaults to 250ms. */
  cancelPollMs?: number
  /** Grace given to the duroxide runtime on teardown. Defaults to 3000ms. */
  shutdownGraceMs?: number
}

export interface WorkflowQueueHandle {
  readonly name: string
  enqueue(input: unknown, options?: { id?: string }): Promise<string>
  get(jobId: string): Promise<WorkflowRun | undefined>
  cancel(jobId: string, reason?: string): Promise<void>
}

export interface WorkflowsKit {
  readonly contract: ReturnType<typeof workflowsContract>
  readonly plugin: SuperLinePlugin
  /** Start a named multi-step workflow. The id is external and unique per instance. */
  run(name: string, id: string, input?: unknown): Promise<string>
  queue(name: string): WorkflowQueueHandle
  cancel(id: string, reason?: string): Promise<void>
  /** Durable signal: enqueued events buffer even if the workflow has not subscribed yet. */
  signal(id: string, queueName: string, data: unknown): Promise<void>
  waitFor(id: string, timeoutMs?: number): Promise<WorkflowStatus>
  history(id: string): Promise<string[]>
  /** Re-arm projection watchers for non-terminal instances; runs automatically at mount. */
  recover(): Promise<string[]>
}

export function workflowsContract() {
  return defineContractPlugin('workflows', {
    collections: {
      [WORKFLOW_RUNS]: {
        schema: workflowRunSchema,
        key: 'id',
        indexes: [
          ['status', 'updatedAt'],
          ['kind', 'name'],
        ],
      },
    },
  })
}

const JOB_WRAPPER = 'jobWrapper:'
const JOB_ACTIVITY = 'job:'
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
// the engine reports cancellation as a failure whose error carries this prefix (its spelling, one l)
const CANCEL_PREFIX = 'canceled:'
// how long a watcher tolerates `notfound` (the engine hasn't taken the instance's first turn yet)
// before declaring the run lost
const NOTFOUND_GRACE_MS = 10_000

interface NormalizedStatus {
  status: string
  customStatus?: string
  output?: unknown
  error?: string
}

const parseEngineJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const normalizeStatus = (snapshot: WorkflowStatus): NormalizedStatus => {
  let status = String(snapshot.status ?? 'unknown').toLowerCase()
  let error = snapshot.error
  if (status === 'failed' && error?.startsWith(CANCEL_PREFIX)) {
    status = 'cancelled'
    error = error.slice(CANCEL_PREFIX.length).trim()
  }
  const terminal = TERMINAL.has(status)
  return {
    status,
    ...(!terminal && snapshot.customStatus != null ? { customStatus: snapshot.customStatus } : {}),
    ...(snapshot.output !== undefined ? { output: parseEngineJson(snapshot.output) } : {}),
    ...(error ? { error } : {}),
  }
}

type Duroxide = typeof import('duroxide')

const loadDuroxide = (): Duroxide => {
  try {
    return createRequire(import.meta.url)('duroxide')
  } catch (error) {
    throw new Error(
      `@super-line/plugin-workflows could not load duroxide's native module on ${process.platform}-${process.arch}. ` +
        `duroxide ships prebuilt binaries for darwin-x64, darwin-arm64, linux-x64 (glibc), linux-arm64 (glibc), ` +
        `and win32-x64; other platforms (including musl/Alpine) are not supported by the upstream engine.`,
      { cause: error },
    )
  }
}

const assertPositive = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`)
}

interface NormalizedOptions {
  provider: WorkflowProvider
  activities: Record<string, WorkflowActivity>
  workflows: Record<string, WorkflowOrchestration>
  queues: Record<string, WorkflowQueueDefinition>
  pollIntervalMs: number
  cancelPollMs: number
  shutdownGraceMs: number
}

const jobWrapper = (name: string, definition: WorkflowQueueDefinition): WorkflowOrchestration =>
  function* (ctx, input) {
    return yield ctx.scheduleActivityWithRetry(JOB_ACTIVITY + name, input, {
      maxAttempts: definition.maxAttempts ?? 3,
      timeoutMs: definition.timeoutMs ?? 300_000,
      // duroxide's .d.ts types backoff as a number, but the engine only accepts its string policy names.
      backoff: 'exponential' as unknown as number,
    })
  }

class WorkflowsRuntime {
  private ctx?: PluginContext
  private ready: Promise<void> = Promise.resolve()
  private client?: DuroxideClient
  private runtime?: DuroxideRuntime
  private closing = false
  private readonly watchers = new Map<string, { timer: ReturnType<typeof setInterval>; notfoundSince?: number }>()

  constructor(
    private readonly duroxide: Duroxide,
    private readonly options: NormalizedOptions,
  ) {}

  setup(ctx: PluginContext): () => Promise<void> {
    this.ctx = ctx
    this.ready = this.initialize()
    return async () => this.close()
  }

  private context(): PluginContext {
    if (!this.ctx) throw new Error('workflows plugin is not mounted on a super-line server')
    return this.ctx
  }

  private runs(): ServerCollectionHandle<WorkflowRun> {
    return this.context().collection(WORKFLOW_RUNS) as ServerCollectionHandle<WorkflowRun>
  }

  private async initialize(): Promise<void> {
    const runtime = new this.duroxide.Runtime(this.options.provider)
    for (const [name, fn] of Object.entries(this.options.activities)) runtime.registerActivity(name, this.wrapActivity(fn))
    for (const [name, gen] of Object.entries(this.options.workflows)) runtime.registerOrchestration(name, gen)
    for (const [name, definition] of Object.entries(this.options.queues)) {
      runtime.registerActivity(JOB_ACTIVITY + name, this.wrapActivity(definition.worker))
      runtime.registerOrchestration(JOB_WRAPPER + name, jobWrapper(name, definition))
    }
    await runtime.start()
    this.runtime = runtime
    this.client = new this.duroxide.Client(this.options.provider)
    await this.rearm()
  }

  private wrapActivity(fn: WorkflowActivity) {
    return async (actx: ActivityContext, input: unknown): Promise<unknown> => {
      const controller = new AbortController()
      const poll = setInterval(() => {
        if (actx.isCancelled()) controller.abort()
      }, this.options.cancelPollMs)
      try {
        return await fn(input, { signal: controller.signal })
      } finally {
        clearInterval(poll)
      }
    }
  }

  private async connected(): Promise<DuroxideClient> {
    await this.ready
    const client = this.client
    if (!client) throw new Error('workflows plugin is not mounted on a super-line server')
    return client
  }

  private watch(id: string, kind: WorkflowRun['kind'], name: string): void {
    if (this.watchers.has(id) || this.closing) return
    const timer = setInterval(() => void this.observe(id, kind, name), this.options.pollIntervalMs)
    this.watchers.set(id, { timer })
  }

  private unwatch(id: string): void {
    const watcher = this.watchers.get(id)
    if (watcher) clearInterval(watcher.timer)
    this.watchers.delete(id)
  }

  private async observe(id: string, kind: WorkflowRun['kind'], name: string): Promise<void> {
    const client = this.client
    if (!client || this.closing) return
    let snapshot: WorkflowStatus
    try {
      snapshot = await client.getStatus(id)
    } catch {
      return
    }
    const normalized = normalizeStatus(snapshot)
    const watcher = this.watchers.get(id)
    if (normalized.status === 'notfound') {
      if (!watcher) return
      watcher.notfoundSince ??= Date.now()
      if (Date.now() - watcher.notfoundSince > NOTFOUND_GRACE_MS) {
        await this.project(id, kind, name, {
          status: 'failed',
          error: `instance was not visible to the engine within ${NOTFOUND_GRACE_MS}ms of starting`,
        })
        this.unwatch(id)
      }
      return
    }
    if (watcher) delete watcher.notfoundSince
    await this.project(id, kind, name, normalized)
    if (TERMINAL.has(normalized.status)) this.unwatch(id)
  }

  private async project(id: string, kind: WorkflowRun['kind'], name: string, normalized: NormalizedStatus): Promise<void> {
    try {
      const prev = await this.runs().read(id)
      if (prev && prev.status === normalized.status && prev.customStatus === normalized.customStatus) return
      const now = Date.now()
      const next: WorkflowRun = {
        id,
        kind,
        name,
        status: normalized.status,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
        ...(normalized.customStatus !== undefined ? { customStatus: normalized.customStatus } : {}),
        ...(normalized.output !== undefined ? { output: normalized.output } : {}),
        ...(normalized.error !== undefined ? { error: normalized.error } : {}),
      }
      if (prev) await this.runs().update(next)
      else await this.runs().insert(next)
    } catch {
      // a racing write (a peer node's insert, teardown) — the next poll settles it
    }
  }

  private async insertRow(id: string, kind: WorkflowRun['kind'], name: string): Promise<void> {
    const now = Date.now()
    await this.runs().insert({ id, kind, name, status: 'starting', createdAt: now, updatedAt: now })
  }

  async run(name: string, id: string, input?: unknown): Promise<string> {
    if (!(name in this.options.workflows)) throw new Error(`Unknown workflow: ${name}`)
    const client = await this.connected()
    await this.insertRow(id, 'workflow', name)
    await client.startOrchestration(id, name, input)
    this.watch(id, 'workflow', name)
    return id
  }

  async enqueue(queue: string, input: unknown, options: { id?: string } = {}): Promise<string> {
    if (!(queue in this.options.queues)) throw new Error(`Unknown queue: ${queue}`)
    const client = await this.connected()
    const id = options.id ?? `${queue}-${globalThis.crypto.randomUUID()}`
    await this.insertRow(id, 'job', queue)
    await client.startOrchestration(id, JOB_WRAPPER + queue, input)
    this.watch(id, 'job', queue)
    return id
  }

  async get(id: string): Promise<WorkflowRun | undefined> {
    await this.ready
    return this.runs().read(id)
  }

  async cancel(id: string, reason?: string): Promise<void> {
    const client = await this.connected()
    await client.cancelInstance(id, reason ?? 'cancelled')
  }

  async signal(id: string, queueName: string, data: unknown): Promise<void> {
    const client = await this.connected()
    await client.enqueueEvent(id, queueName, JSON.stringify(data))
  }

  async waitFor(id: string, timeoutMs = 30_000): Promise<WorkflowStatus> {
    const client = await this.connected()
    return client.waitForOrchestration(id, timeoutMs)
  }

  async history(id: string): Promise<string[]> {
    const client = await this.connected()
    const info = await client.getInstanceInfo(id)
    const events = await client.readExecutionHistory(id, Number(info.currentExecutionId ?? 1))
    return events.map((event) => event.kind)
  }

  async recover(): Promise<string[]> {
    await this.ready
    return this.rearm()
  }

  /**
   * Multi-node note: every node with the plugin re-arms and watches independently — there is no
   * leader. Projection writes are pure functions of engine state and terminal states are absorbing,
   * so concurrent watchers converge on the same row; a lost race just retries on the next poll.
   */
  private async rearm(): Promise<string[]> {
    const client = this.client
    if (!client) throw new Error('workflows plugin is not mounted on a super-line server')
    const rearmed: string[] = []
    for (const id of await client.listAllInstances()) {
      if (this.watchers.has(id)) continue
      let normalized: NormalizedStatus
      try {
        normalized = normalizeStatus(await client.getStatus(id))
      } catch {
        continue
      }
      if (TERMINAL.has(normalized.status)) continue
      const { kind, name } = await this.identify(client, id)
      if (normalized.status !== 'notfound') await this.project(id, kind, name, normalized)
      this.watch(id, kind, name)
      rearmed.push(id)
    }
    return rearmed
  }

  /** Run metadata comes from the durable collection row when one survives; the engine is the fallback. */
  private async identify(client: DuroxideClient, id: string): Promise<Pick<WorkflowRun, 'kind' | 'name'>> {
    const prev = await this.runs().read(id)
    if (prev) return { kind: prev.kind, name: prev.name }
    const info = await client.getInstanceInfo(id)
    const orchestration = info.orchestrationName ?? ''
    return orchestration.startsWith(JOB_WRAPPER)
      ? { kind: 'job', name: orchestration.slice(JOB_WRAPPER.length) }
      : { kind: 'workflow', name: orchestration }
  }

  private async close(): Promise<void> {
    this.closing = true
    for (const watcher of this.watchers.values()) clearInterval(watcher.timer)
    this.watchers.clear()
    await this.ready.catch(() => undefined)
    await this.runtime?.shutdown(this.options.shutdownGraceMs)
  }
}

export function workflows(options: WorkflowsOptions): WorkflowsKit {
  const duroxide = loadDuroxide()
  const normalized: NormalizedOptions = {
    provider: options.provider,
    activities: options.activities ?? {},
    workflows: options.workflows ?? {},
    queues: options.queues ?? {},
    pollIntervalMs: options.pollIntervalMs ?? 300,
    cancelPollMs: options.cancelPollMs ?? 250,
    shutdownGraceMs: options.shutdownGraceMs ?? 3_000,
  }
  assertPositive('pollIntervalMs', normalized.pollIntervalMs)
  assertPositive('cancelPollMs', normalized.cancelPollMs)
  assertPositive('shutdownGraceMs', normalized.shutdownGraceMs)
  for (const name of [...Object.keys(normalized.activities), ...Object.keys(normalized.workflows)]) {
    if (!name) throw new TypeError('activity and workflow names cannot be empty')
    if (name.startsWith(JOB_ACTIVITY) || name.startsWith(JOB_WRAPPER))
      throw new TypeError(`"${name}" collides with the kit's reserved job prefixes`)
  }
  for (const [name, definition] of Object.entries(normalized.queues)) {
    if (!name) throw new TypeError('queue names cannot be empty')
    const maxAttempts = definition.maxAttempts ?? 3
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError(`${name}.maxAttempts must be at least 1`)
    assertPositive(`${name}.timeoutMs`, definition.timeoutMs ?? 300_000)
  }

  const runtime = new WorkflowsRuntime(duroxide, normalized)
  const contract = workflowsContract()
  const plugin: SuperLinePlugin = {
    name: 'workflows',
    policies: {
      [WORKFLOW_RUNS]: {},
    },
    setup: (ctx) => runtime.setup(ctx),
  }

  return {
    contract,
    plugin,
    run: (name, id, input) => runtime.run(name, id, input),
    queue: (name) => ({
      name,
      enqueue: (input, enqueueOptions) => runtime.enqueue(name, input, enqueueOptions),
      get: (id) => runtime.get(id),
      cancel: (id, reason) => runtime.cancel(id, reason),
    }),
    cancel: (id, reason) => runtime.cancel(id, reason),
    signal: (id, queueName, data) => runtime.signal(id, queueName, data),
    waitFor: (id, timeoutMs) => runtime.waitFor(id, timeoutMs),
    history: (id) => runtime.history(id),
    recover: () => runtime.recover(),
  }
}
