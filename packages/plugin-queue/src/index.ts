import { CronExpressionParser } from 'cron-parser'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import * as z from 'zod'
import {
  and,
  defineContractPlugin,
  eq,
  isIn,
  lte,
  validate,
  type CollectionQuery,
  type InferIn,
  type InferOut,
  type Schema,
} from '@super-line/core'
import type {
  PluginContext,
  ServerCollectionHandle,
  ServerCollectionOp,
  SuperLinePlugin,
} from '@super-line/server'

dayjs.extend(utc)
dayjs.extend(timezone)

export const QUEUE_JOBS = 'queueJobs'
export const QUEUE_SCHEDULES = 'queueSchedules'
export const QUEUE_SLOTS = 'queueSlots'

const statuses = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const
const backoffSchema = z.object({
  type: z.enum(['fixed', 'exponential']),
  delayMs: z.number(),
  maxDelayMs: z.number().optional(),
  jitter: z.number().optional(),
})
const retentionSchema = z.object({
  completedMs: z.number().nullable(),
  failedMs: z.number().nullable(),
  cancelledMs: z.number().nullable(),
})
const errorSchema = z.object({
  name: z.string(),
  message: z.string(),
  code: z.string().optional(),
  attempt: z.number(),
  at: z.number(),
})

export const queueJobSchema = z.object({
  id: z.string(),
  queue: z.string(),
  status: z.enum(statuses),
  input: z.unknown(),
  result: z.unknown().optional(),
  lastError: errorSchema.optional(),
  priority: z.number(),
  availableAt: z.number(),
  attempt: z.number(),
  maxAttempts: z.number(),
  backoff: backoffSchema,
  timeoutMs: z.number().optional(),
  retention: retentionSchema,
  deleteAt: z.number().optional(),
  revision: z.number(),
  runId: z.string().optional(),
  slotId: z.string().optional(),
  leaseExpiresAt: z.number().optional(),
  nodeKey: z.string().optional(),
  nodeId: z.string().optional(),
  scheduleId: z.string().optional(),
  scheduledFor: z.number().optional(),
  retryOf: z.string().optional(),
  rootJobId: z.string().optional(),
  cancelRequestedAt: z.number().optional(),
  cancelReason: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
})

export const queueScheduleSchema = z.object({
  id: z.string(),
  queue: z.string(),
  cron: z.string(),
  timezone: z.string(),
  input: z.unknown(),
  enabled: z.boolean(),
  misfirePolicy: z.enum(['latest', 'skip', 'all']),
  maxCatchUp: z.number().optional(),
  overlapPolicy: z.enum(['allow', 'skip']),
  nextRunAt: z.number(),
  lastScheduledAt: z.number().optional(),
  lastJobId: z.string().optional(),
  revision: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const queueSlotSchema = z.object({
  id: z.string(),
  queue: z.string(),
  index: z.number(),
  revision: z.number(),
  jobId: z.string().optional(),
  runId: z.string().optional(),
  nodeKey: z.string().optional(),
  nodeId: z.string().optional(),
  leaseExpiresAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type QueueJob = z.infer<typeof queueJobSchema>
export type QueueSchedule = z.infer<typeof queueScheduleSchema>
export type QueueSlot = z.infer<typeof queueSlotSchema>

export interface WorkerContext {
  readonly jobId: string
  readonly attempt: number
  readonly signal: AbortSignal
}

export interface BackoffConfig {
  type?: 'fixed' | 'exponential'
  delayMs?: number
  maxDelayMs?: number
  jitter?: number
}

export interface QueueDefinition<I extends Schema = Schema, R extends Schema = Schema> {
  input: I
  result: R
  worker: (input: InferOut<I>, ctx: WorkerContext) => InferIn<R> | Promise<InferIn<R>>
  concurrency: number
  leaseMs?: number
  timeoutMs?: number
  retry?: { maxAttempts?: number; backoff?: BackoffConfig }
  retention?: Partial<RetentionConfig>
}

export type QueueDefinitions = Record<string, QueueDefinition<any, any>>

export interface RetentionConfig {
  completedMs: number | null
  failedMs: number | null
  cancelledMs: number | null
}

export interface QueueOptions<Q extends QueueDefinitions> {
  queues: Q
  pollIntervalMs?: number
  shutdownGraceMs?: number
  maxCatchUp?: number
  timezone?: string
}

export interface EnqueueOptions {
  id?: string
  priority?: number
  availableAt?: number
}

export interface CreateScheduleOptions<N extends string = string> {
  id?: string
  queue: N
  cron: string
  timezone?: string
  input: unknown
  enabled?: boolean
  misfirePolicy?: 'latest' | 'skip' | 'all'
  maxCatchUp?: number
  overlapPolicy?: 'allow' | 'skip'
}

export interface UpdateScheduleOptions {
  cron?: string
  timezone?: string
  input?: unknown
  enabled?: boolean
  misfirePolicy?: 'latest' | 'skip' | 'all'
  maxCatchUp?: number
  overlapPolicy?: 'allow' | 'skip'
}

export class PermanentJobError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'PermanentJobError'
    this.code = code
  }
}

type QueueName<Q extends QueueDefinitions> = keyof Q & string
type InputOf<Q extends QueueDefinitions, N extends QueueName<Q>> = InferIn<Q[N]['input']>
type ScheduleCreateOf<Q extends QueueDefinitions> = {
  [N in QueueName<Q>]: Omit<CreateScheduleOptions<N>, 'input'> & { input: InputOf<Q, N> }
}[QueueName<Q>]

export interface QueueKit<Q extends QueueDefinitions> {
  readonly contract: ReturnType<typeof queueContract>
  readonly plugin: SuperLinePlugin
  enqueue<N extends QueueName<Q>>(queue: N, input: InputOf<Q, N>, options?: EnqueueOptions): Promise<QueueJob>
  get(jobId: string): Promise<QueueJob | undefined>
  list(query?: CollectionQuery): Promise<QueueJob[]>
  cancel(jobId: string, options?: { reason?: string }): Promise<QueueJob>
  retry(jobId: string, options?: EnqueueOptions): Promise<QueueJob>
  readonly schedules: {
    create(options: ScheduleCreateOf<Q>): Promise<QueueSchedule>
    update(id: string, patch: UpdateScheduleOptions): Promise<QueueSchedule>
    pause(id: string): Promise<QueueSchedule>
    resume(id: string): Promise<QueueSchedule>
    delete(id: string): Promise<void>
    trigger(id: string): Promise<QueueJob>
    get(id: string): Promise<QueueSchedule | undefined>
    list(query?: CollectionQuery): Promise<QueueSchedule[]>
  }
}

export function queueContract() {
  return defineContractPlugin('queue', {
    collections: {
      [QUEUE_JOBS]: {
        schema: queueJobSchema,
        key: 'id',
        indexes: [
          ['queue', 'status', 'availableAt', 'priority', 'createdAt'],
          ['status', 'leaseExpiresAt'],
          ['deleteAt'],
          ['scheduleId', 'status'],
        ],
      },
      [QUEUE_SCHEDULES]: { schema: queueScheduleSchema, key: 'id', indexes: [['enabled', 'nextRunAt']] },
      [QUEUE_SLOTS]: { schema: queueSlotSchema, key: 'id', indexes: [['queue', 'index']] },
    },
  })
}

const DEFAULT_RETENTION: RetentionConfig = {
  completedMs: 24 * 60 * 60 * 1000,
  failedMs: 7 * 24 * 60 * 60 * 1000,
  cancelledMs: 24 * 60 * 60 * 1000,
}

const assertPositive = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`)
}

const assertTimezone = (value: string): void => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
  } catch {
    throw new TypeError(`Invalid IANA timezone: ${value}`)
  }
}

const parseCron = (cron: string, tz: string, currentDate: number): number => {
  if (cron.trim().split(/\s+/).length !== 5) throw new TypeError('cron must contain exactly five fields')
  return CronExpressionParser.parse(cron, { currentDate: new Date(currentDate), tz }).next().getTime()
}

const occurrenceKey = (schedule: QueueSchedule, at: number): string =>
  `${schedule.id}:${dayjs(at).tz(schedule.timezone).format('YYYY-MM-DDTHH:mm')}`

const randomId = (): string => globalThis.crypto.randomUUID()

class QueueRuntime<Q extends QueueDefinitions> {
  private ctx?: PluginContext
  private ready: Promise<void> = Promise.resolve()
  private closing = false
  private timers: ReturnType<typeof setInterval>[] = []
  private running = new Set<Promise<void>>()
  private controllers = new Set<AbortController>()
  private abandoning = false
  private unsubscribeWake?: () => void

  constructor(
    private readonly definitions: Q,
    private readonly options: Required<Pick<QueueOptions<Q>, 'pollIntervalMs' | 'shutdownGraceMs' | 'maxCatchUp' | 'timezone'>>,
  ) {}

  setup(ctx: PluginContext): () => Promise<void> {
    this.ctx = ctx
    this.ready = this.initialize()
    const wake = ctx.channel('wake')
    this.unsubscribeWake = wake.subscribe(() => void this.tick())
    this.timers.push(setInterval(() => void this.tick(), this.options.pollIntervalMs))
    this.timers.push(setInterval(() => void this.scheduleTick(), Math.min(this.options.pollIntervalMs, 1_000)))
    void this.ready.then(() => Promise.all([this.tick(), this.scheduleTick()]))
    return async () => this.close()
  }

  private context(): PluginContext {
    if (!this.ctx) throw new Error('queue plugin is not mounted on a super-line server')
    return this.ctx
  }

  private jobs(): ServerCollectionHandle<QueueJob> {
    return this.context().collection(QUEUE_JOBS) as ServerCollectionHandle<QueueJob>
  }

  private slots(): ServerCollectionHandle<QueueSlot> {
    return this.context().collection(QUEUE_SLOTS) as ServerCollectionHandle<QueueSlot>
  }

  private scheduleRows(): ServerCollectionHandle<QueueSchedule> {
    return this.context().collection(QUEUE_SCHEDULES) as ServerCollectionHandle<QueueSchedule>
  }

  private async initialize(): Promise<void> {
    const now = Date.now()
    for (const [queue, definition] of Object.entries(this.definitions)) {
      for (let index = 0; index < definition.concurrency; index++) {
        try {
          await this.slots().insert({
            id: `${queue}:${index}`,
            queue,
            index,
            revision: 0,
            createdAt: now,
            updatedAt: now,
          })
        } catch (error) {
          if (!(error instanceof Error) || !/exists|conflict/i.test(error.message)) throw error
        }
      }
    }
  }

  private definition(queue: string): QueueDefinition {
    const definition = this.definitions[queue]
    if (!definition) throw new Error(`Unknown queue: ${queue}`)
    return definition
  }

  async enqueue(queue: string, input: unknown, options: EnqueueOptions = {}, links: Partial<QueueJob> = {}): Promise<QueueJob> {
    await this.ready
    const definition = this.definition(queue)
    const parsed = await validate(definition.input, input)
    const now = Date.now()
    const retry = definition.retry
    const retention = { ...DEFAULT_RETENTION, ...definition.retention }
    const job: QueueJob = {
      id: options.id ?? randomId(),
      queue,
      status: 'queued',
      input: parsed,
      priority: options.priority ?? 0,
      availableAt: options.availableAt ?? now,
      attempt: 0,
      maxAttempts: retry?.maxAttempts ?? 3,
      backoff: {
        type: retry?.backoff?.type ?? 'exponential',
        delayMs: retry?.backoff?.delayMs ?? 1_000,
        maxDelayMs: retry?.backoff?.maxDelayMs ?? 60_000,
        jitter: retry?.backoff?.jitter ?? 0.2,
      },
      timeoutMs: definition.timeoutMs ?? 300_000,
      retention,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      ...links,
    }
    await this.jobs().insert(job)
    this.context().channel('wake').publish({ queue })
    void this.tick()
    return job
  }

  async get(jobId: string): Promise<QueueJob | undefined> {
    await this.ready
    return this.jobs().read(jobId)
  }

  async list(query?: CollectionQuery): Promise<QueueJob[]> {
    await this.ready
    return this.jobs().snapshot(query)
  }

  async cancel(jobId: string, reason?: string): Promise<QueueJob> {
    await this.ready
    const job = await this.jobs().read(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)
    if (job.status === 'queued') {
      const now = Date.now()
      const next: QueueJob = {
        ...job,
        status: 'cancelled',
        cancelRequestedAt: now,
        ...(reason ? { cancelReason: reason } : {}),
        finishedAt: now,
        updatedAt: now,
        revision: job.revision + 1,
        ...this.expiry('cancelled', job.retention, now),
      }
      const applied = await this.context().conditionalBatch(
        [{ collection: QUEUE_JOBS, id: job.id, filter: and(eq('revision', job.revision), eq('status', 'queued')) }],
        [{ op: 'update', collection: QUEUE_JOBS, row: next }],
      )
      if (!applied) return this.cancel(jobId, reason)
      return next
    }
    if (job.status !== 'running') return job
    const now = Date.now()
    const next = {
      ...job,
      cancelRequestedAt: now,
      ...(reason ? { cancelReason: reason } : {}),
      updatedAt: now,
      revision: job.revision + 1,
    }
    const applied = await this.context().conditionalBatch(
      [{ collection: QUEUE_JOBS, id: job.id, filter: and(eq('revision', job.revision), eq('status', 'running')) }],
      [{ op: 'update', collection: QUEUE_JOBS, row: next }],
    )
    if (!applied) return this.cancel(jobId, reason)
    this.context().channel('cancel').publish({ jobId })
    return next
  }

  async retry(jobId: string, options?: EnqueueOptions): Promise<QueueJob> {
    const job = await this.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)
    if (!['failed', 'cancelled', 'completed'].includes(job.status)) throw new Error(`Job is not terminal: ${jobId}`)
    return this.enqueue(job.queue, job.input, options, { retryOf: job.id, rootJobId: job.rootJobId ?? job.id })
  }

  private async tick(): Promise<void> {
    if (this.closing) return
    await this.ready
    await this.reap()
    for (const [queue, definition] of Object.entries(this.definitions)) {
      const slots = await this.slots().snapshot({
        filter: eq('queue', queue),
        orderBy: [{ field: 'index', dir: 'asc' }],
      })
      for (const slot of slots) {
        if (slot.index >= definition.concurrency) continue
        if (slot.runId && (slot.leaseExpiresAt ?? 0) > Date.now()) continue
        const job = await this.claim(queue, slot, definition)
        if (job) {
          const task = this.run(job, definition).finally(() => this.running.delete(task))
          this.running.add(task)
        }
      }
    }
  }

  private async claim(queue: string, slot: QueueSlot, definition: QueueDefinition): Promise<QueueJob | undefined> {
    const now = Date.now()
    const candidates = await this.jobs().snapshot({
      filter: and(eq('queue', queue), eq('status', 'queued'), lte('availableAt', now)),
      orderBy: [
        { field: 'priority', dir: 'desc' },
        { field: 'availableAt', dir: 'asc' },
        { field: 'createdAt', dir: 'asc' },
      ],
      limit: 1,
    })
    const job = candidates[0]
    if (!job) return undefined
    const runId = randomId()
    const leaseExpiresAt = now + (definition.leaseMs ?? 30_000)
    const nextJob: QueueJob = {
      ...job,
      status: 'running',
      attempt: job.attempt + 1,
      runId,
      slotId: slot.id,
      leaseExpiresAt,
      nodeKey: this.context().nodeKey,
      nodeId: this.context().nodeId,
      startedAt: job.startedAt ?? now,
      updatedAt: now,
      revision: job.revision + 1,
    }
    const nextSlot: QueueSlot = {
      ...slot,
      jobId: job.id,
      runId,
      nodeKey: this.context().nodeKey,
      nodeId: this.context().nodeId,
      leaseExpiresAt,
      updatedAt: now,
      revision: slot.revision + 1,
    }
    const applied = await this.context().conditionalBatch(
      [
        { collection: QUEUE_JOBS, id: job.id, filter: and(eq('revision', job.revision), eq('status', 'queued')) },
        { collection: QUEUE_SLOTS, id: slot.id, filter: eq('revision', slot.revision) },
      ],
      [
        { op: 'update', collection: QUEUE_JOBS, row: nextJob },
        { op: 'update', collection: QUEUE_SLOTS, row: nextSlot },
      ],
    )
    return applied ? nextJob : undefined
  }

  private async run(job: QueueJob, definition: QueueDefinition): Promise<void> {
    const controller = new AbortController()
    this.controllers.add(controller)
    const cancel = this.context().channel('cancel').subscribe((data) => {
      if ((data as { jobId?: string }).jobId === job.id) controller.abort()
    })
    const leaseMs = definition.leaseMs ?? 30_000
    const heartbeat = setInterval(() => void this.heartbeat(job, leaseMs, controller), Math.max(100, Math.floor(leaseMs / 3)))
    let timeout: ReturnType<typeof setTimeout> | undefined
    if (job.timeoutMs) timeout = setTimeout(() => controller.abort(), job.timeoutMs)
    try {
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => reject(new Error('Job aborted'))
        if (controller.signal.aborted) fail()
        else controller.signal.addEventListener('abort', fail, { once: true })
      })
      const result = await Promise.race([
        Promise.resolve(definition.worker(job.input, { jobId: job.id, attempt: job.attempt, signal: controller.signal })),
        aborted,
      ])
      let parsed: unknown
      try {
        parsed = await validate(definition.result, result)
      } catch {
        await this.settle(job, 'failed', undefined, new PermanentJobError('Worker returned an invalid result', 'INVALID_RESULT'))
        return
      }
      await this.settle(job, 'completed', parsed)
    } catch (error) {
      if (this.abandoning) return
      await this.settle(job, undefined, undefined, error)
    } finally {
      this.controllers.delete(controller)
      clearInterval(heartbeat)
      if (timeout) clearTimeout(timeout)
      cancel()
    }
  }

  private async heartbeat(job: QueueJob, leaseMs: number, controller: AbortController): Promise<void> {
    if (this.closing && controller.signal.aborted) return
    const current = await this.jobs().read(job.id)
    const slot = job.slotId ? await this.slots().read(job.slotId) : undefined
    if (!current || !slot || current.runId !== job.runId || slot.runId !== job.runId) {
      controller.abort()
      return
    }
    if (current.cancelRequestedAt) controller.abort()
    const now = Date.now()
    const leaseExpiresAt = now + leaseMs
    await this.context().conditionalBatch(
      [
        { collection: QUEUE_JOBS, id: current.id, filter: eq('runId', job.runId!) },
        { collection: QUEUE_SLOTS, id: slot.id, filter: eq('runId', job.runId!) },
      ],
      [
        {
          op: 'update',
          collection: QUEUE_JOBS,
          row: { ...current, leaseExpiresAt, updatedAt: now, revision: current.revision + 1 },
        },
        {
          op: 'update',
          collection: QUEUE_SLOTS,
          row: { ...slot, leaseExpiresAt, updatedAt: now, revision: slot.revision + 1 },
        },
      ],
    )
  }

  private async settle(
    job: QueueJob,
    terminal?: 'completed' | 'failed',
    result?: unknown,
    error?: unknown,
    leaseCutoff?: number,
  ): Promise<void> {
    const current = await this.jobs().read(job.id)
    const slot = job.slotId ? await this.slots().read(job.slotId) : undefined
    if (!current || !slot || current.runId !== job.runId || slot.runId !== job.runId) return
    if (leaseCutoff !== undefined && ((current.leaseExpiresAt ?? 0) > leaseCutoff || (slot.leaseExpiresAt ?? 0) > leaseCutoff))
      return
    const now = Date.now()
    const cancelled = Boolean(current.cancelRequestedAt)
    const permanent = error instanceof PermanentJobError
    const exhausted = current.attempt >= current.maxAttempts
    const status = cancelled ? 'cancelled' : terminal ?? (permanent || exhausted ? 'failed' : 'queued')
    const lastError = error ? this.errorOf(error, current.attempt, now) : current.lastError
    const next: QueueJob = {
      ...current,
      status,
      ...(result !== undefined ? { result } : {}),
      ...(lastError ? { lastError } : {}),
      ...(status === 'queued' ? { availableAt: now + this.backoff(current) } : { finishedAt: now }),
      updatedAt: now,
      revision: current.revision + 1,
      ...(['completed', 'failed', 'cancelled'].includes(status) ? this.expiry(status as 'completed' | 'failed' | 'cancelled', current.retention, now) : {}),
    }
    delete next.runId
    delete next.slotId
    delete next.leaseExpiresAt
    delete next.nodeId
    delete next.nodeKey
    const released: QueueSlot = { ...slot, updatedAt: now, revision: slot.revision + 1 }
    delete released.jobId
    delete released.runId
    delete released.nodeId
    delete released.nodeKey
    delete released.leaseExpiresAt
    const jobFence = leaseCutoff === undefined
      ? eq('runId', job.runId!)
      : and(eq('runId', job.runId!), lte('leaseExpiresAt', leaseCutoff))
    const slotFence = leaseCutoff === undefined
      ? eq('runId', job.runId!)
      : and(eq('runId', job.runId!), lte('leaseExpiresAt', leaseCutoff))
    await this.context().conditionalBatch(
      [
        { collection: QUEUE_JOBS, id: current.id, filter: jobFence },
        { collection: QUEUE_SLOTS, id: slot.id, filter: slotFence },
      ],
      [
        { op: 'update', collection: QUEUE_JOBS, row: next },
        { op: 'update', collection: QUEUE_SLOTS, row: released },
      ],
    )
    if (status === 'queued') this.context().channel('wake').publish({ queue: current.queue })
  }

  private backoff(job: QueueJob): number {
    const base = job.backoff.type === 'fixed'
      ? job.backoff.delayMs
      : Math.min(job.backoff.delayMs * 2 ** Math.max(0, job.attempt - 1), job.backoff.maxDelayMs ?? Number.MAX_SAFE_INTEGER)
    const jitter = job.backoff.jitter ?? 0
    return Math.max(0, Math.round(base * (1 + (Math.random() * 2 - 1) * jitter)))
  }

  private errorOf(error: unknown, attempt: number, at: number): QueueJob['lastError'] {
    if (error instanceof Error) {
      const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
      return { name: error.name, message: error.message, ...(code ? { code } : {}), attempt, at }
    }
    return { name: 'Error', message: String(error), attempt, at }
  }

  private expiry(status: 'completed' | 'failed' | 'cancelled', retention: RetentionConfig, now: number): Pick<QueueJob, 'deleteAt'> | {} {
    const duration = retention[`${status}Ms`]
    return duration === null ? {} : { deleteAt: now + duration }
  }

  private async reap(): Promise<void> {
    const now = Date.now()
    const expired = await this.jobs().snapshot({ filter: and(eq('status', 'running'), lte('leaseExpiresAt', now)) })
    for (const job of expired) {
      if (!job.slotId || !job.runId) continue
      const slot = await this.slots().read(job.slotId)
      if (!slot || slot.runId !== job.runId) continue
      await this.settle(job, undefined, undefined, new Error('Worker lease expired'), now)
    }
    const deletable = await this.jobs().snapshot({ filter: lte('deleteAt', now) })
    for (const job of deletable) await this.jobs().delete(job.id)
  }

  async createSchedule(options: CreateScheduleOptions): Promise<QueueSchedule> {
    await this.ready
    const definition = this.definition(options.queue)
    const input = await validate(definition.input, options.input)
    const tz = options.timezone ?? this.options.timezone
    assertTimezone(tz)
    const maxCatchUp = options.maxCatchUp ?? this.options.maxCatchUp
    if (!Number.isInteger(maxCatchUp) || maxCatchUp <= 0) throw new TypeError('maxCatchUp must be a positive integer')
    const now = Date.now()
    const row: QueueSchedule = {
      id: options.id ?? randomId(),
      queue: options.queue,
      cron: options.cron,
      timezone: tz,
      input,
      enabled: options.enabled ?? true,
      misfirePolicy: options.misfirePolicy ?? 'latest',
      maxCatchUp,
      overlapPolicy: options.overlapPolicy ?? 'allow',
      nextRunAt: parseCron(options.cron, tz, now),
      revision: 0,
      createdAt: now,
      updatedAt: now,
    }
    await this.scheduleRows().insert(row)
    return row
  }

  async updateSchedule(id: string, patch: UpdateScheduleOptions): Promise<QueueSchedule> {
    await this.ready
    const current = await this.scheduleRows().read(id)
    if (!current) throw new Error(`Schedule not found: ${id}`)
    const timezone = patch.timezone ?? current.timezone
    assertTimezone(timezone)
    if (patch.maxCatchUp !== undefined && (!Number.isInteger(patch.maxCatchUp) || patch.maxCatchUp <= 0))
      throw new TypeError('maxCatchUp must be a positive integer')
    const input = patch.input === undefined ? current.input : await validate(this.definition(current.queue).input, patch.input)
    const now = Date.now()
    const next: QueueSchedule = {
      ...current,
      ...patch,
      timezone,
      input,
      nextRunAt:
        patch.cron !== undefined || patch.timezone !== undefined || (patch.enabled === true && !current.enabled)
          ? parseCron(patch.cron ?? current.cron, timezone, now)
          : current.nextRunAt,
      updatedAt: now,
      revision: current.revision + 1,
    }
    const applied = await this.context().conditionalBatch(
      [{ collection: QUEUE_SCHEDULES, id, filter: eq('revision', current.revision) }],
      [{ op: 'update', collection: QUEUE_SCHEDULES, row: next }],
    )
    if (!applied) return this.updateSchedule(id, patch)
    return next
  }

  pauseSchedule(id: string): Promise<QueueSchedule> {
    return this.updateSchedule(id, { enabled: false })
  }

  resumeSchedule(id: string): Promise<QueueSchedule> {
    return this.updateSchedule(id, { enabled: true })
  }

  async deleteSchedule(id: string): Promise<void> {
    const current = await this.scheduleRows().read(id)
    if (!current) return
    const applied = await this.context().conditionalBatch(
      [{ collection: QUEUE_SCHEDULES, id, filter: eq('revision', current.revision) }],
      [{ op: 'delete', collection: QUEUE_SCHEDULES, id }],
    )
    if (!applied) await this.deleteSchedule(id)
  }

  async triggerSchedule(id: string): Promise<QueueJob> {
    const schedule = await this.scheduleRows().read(id)
    if (!schedule) throw new Error(`Schedule not found: ${id}`)
    return this.enqueue(schedule.queue, schedule.input, {}, { scheduleId: schedule.id, scheduledFor: Date.now() })
  }

  async getSchedule(id: string): Promise<QueueSchedule | undefined> {
    await this.ready
    return this.scheduleRows().read(id)
  }

  async listSchedules(query?: CollectionQuery): Promise<QueueSchedule[]> {
    await this.ready
    return this.scheduleRows().snapshot(query)
  }

  private async scheduleTick(): Promise<void> {
    if (this.closing) return
    await this.ready
    const due = await this.scheduleRows().snapshot({
      filter: and(eq('enabled', true), lte('nextRunAt', Date.now())),
      orderBy: [{ field: 'nextRunAt', dir: 'asc' }],
    })
    for (const schedule of due) await this.advanceSchedule(schedule)
  }

  private async advanceSchedule(schedule: QueueSchedule): Promise<void> {
    const now = Date.now()
    const occurrences: number[] = []
    let cursor = schedule.nextRunAt
    const limit = schedule.maxCatchUp ?? this.options.maxCatchUp
    while (cursor <= now && occurrences.length < limit) {
      occurrences.push(cursor)
      cursor = parseCron(schedule.cron, schedule.timezone, cursor)
    }
    while (cursor <= now) cursor = parseCron(schedule.cron, schedule.timezone, cursor)
    let selected = schedule.misfirePolicy === 'skip'
      ? occurrences.filter((at) => now - at <= Math.max(1_000, this.options.pollIntervalMs * 2))
      : occurrences
    if (schedule.misfirePolicy === 'latest') selected = occurrences.slice(-1)
    selected = [...new Map(selected.map((at) => [occurrenceKey(schedule, at), at])).values()]
    if (schedule.overlapPolicy === 'skip') {
      const active = await this.jobs().snapshot({
        filter: and(eq('scheduleId', schedule.id), isIn('status', ['queued', 'running'])),
        limit: 1,
      })
      if (active.length) selected = []
    }
    const jobs = await Promise.all(selected.map((at) => this.scheduledJob(schedule, at)))
    const latest = jobs.at(-1)
    const nextSchedule: QueueSchedule = {
      ...schedule,
      nextRunAt: cursor,
      lastScheduledAt: selected.at(-1) ?? schedule.lastScheduledAt,
      lastJobId: latest?.id ?? schedule.lastJobId,
      updatedAt: now,
      revision: schedule.revision + 1,
    }
    const ops: ServerCollectionOp[] = [
      ...jobs.map((row) => ({ op: 'insert' as const, collection: QUEUE_JOBS, row })),
      { op: 'update', collection: QUEUE_SCHEDULES, row: nextSchedule },
    ]
    const applied = await this.context().conditionalBatch(
      [{ collection: QUEUE_SCHEDULES, id: schedule.id, filter: eq('revision', schedule.revision) }],
      ops,
    )
    if (applied && jobs.length) {
      this.context().channel('wake').publish({ queue: schedule.queue })
      void this.tick()
    }
  }

  private async scheduledJob(schedule: QueueSchedule, at: number): Promise<QueueJob> {
    const definition = this.definition(schedule.queue)
    const now = Date.now()
    return {
      id: occurrenceKey(schedule, at),
      queue: schedule.queue,
      status: 'queued',
      input: schedule.input,
      priority: 0,
      availableAt: now,
      attempt: 0,
      maxAttempts: definition.retry?.maxAttempts ?? 3,
      backoff: {
        type: definition.retry?.backoff?.type ?? 'exponential',
        delayMs: definition.retry?.backoff?.delayMs ?? 1_000,
        maxDelayMs: definition.retry?.backoff?.maxDelayMs ?? 60_000,
        jitter: definition.retry?.backoff?.jitter ?? 0.2,
      },
      timeoutMs: definition.timeoutMs ?? 300_000,
      retention: { ...DEFAULT_RETENTION, ...definition.retention },
      scheduleId: schedule.id,
      scheduledFor: at,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    }
  }

  private async close(): Promise<void> {
    this.closing = true
    for (const timer of this.timers) clearInterval(timer)
    this.unsubscribeWake?.()
    const deadline = Date.now() + this.options.shutdownGraceMs
    while (this.running.size && Date.now() < deadline) {
      await Promise.race([Promise.allSettled(this.running), new Promise((resolve) => setTimeout(resolve, 25))])
    }
    if (this.running.size) {
      this.abandoning = true
      for (const controller of this.controllers) controller.abort()
      await Promise.allSettled(this.running)
    }
  }
}

export function queue<const Q extends QueueDefinitions>(options: QueueOptions<Q>): QueueKit<Q> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const shutdownGraceMs = options.shutdownGraceMs ?? 30_000
  const maxCatchUp = options.maxCatchUp ?? 100
  const defaultTimezone = options.timezone ?? 'UTC'
  assertPositive('pollIntervalMs', pollIntervalMs)
  assertPositive('shutdownGraceMs', shutdownGraceMs)
  assertPositive('maxCatchUp', maxCatchUp)
  assertTimezone(defaultTimezone)
  for (const [name, definition] of Object.entries(options.queues)) {
    if (!name) throw new TypeError('queue names cannot be empty')
    if (!Number.isInteger(definition.concurrency) || definition.concurrency <= 0)
      throw new TypeError(`${name}.concurrency must be a positive integer`)
    assertPositive(`${name}.leaseMs`, definition.leaseMs ?? 30_000)
    assertPositive(`${name}.timeoutMs`, definition.timeoutMs ?? 300_000)
    const maxAttempts = definition.retry?.maxAttempts ?? 3
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError(`${name}.retry.maxAttempts must be at least 1`)
    const jitter = definition.retry?.backoff?.jitter ?? 0.2
    if (jitter < 0 || jitter > 1) throw new TypeError(`${name}.retry.backoff.jitter must be between 0 and 1`)
    assertPositive(`${name}.retry.backoff.delayMs`, definition.retry?.backoff?.delayMs ?? 1_000)
    assertPositive(`${name}.retry.backoff.maxDelayMs`, definition.retry?.backoff?.maxDelayMs ?? 60_000)
    for (const [key, value] of Object.entries({ ...DEFAULT_RETENTION, ...definition.retention })) {
      if (value !== null && (!Number.isFinite(value) || value < 0))
        throw new TypeError(`${name}.retention.${key} must be null or a non-negative number`)
    }
  }

  const runtime = new QueueRuntime(options.queues, { pollIntervalMs, shutdownGraceMs, maxCatchUp, timezone: defaultTimezone })
  const contract = queueContract()
  const plugin: SuperLinePlugin = {
    name: 'queue',
    policies: {
      [QUEUE_JOBS]: {},
      [QUEUE_SCHEDULES]: {},
      [QUEUE_SLOTS]: {},
    },
    setup: (ctx) => runtime.setup(ctx),
  }

  return {
    contract,
    plugin,
    enqueue: (name, input, enqueueOptions) => runtime.enqueue(name, input, enqueueOptions),
    get: (id) => runtime.get(id),
    list: (query) => runtime.list(query),
    cancel: (id, cancelOptions) => runtime.cancel(id, cancelOptions?.reason),
    retry: (id, enqueueOptions) => runtime.retry(id, enqueueOptions),
    schedules: {
      create: (schedule) => runtime.createSchedule(schedule),
      update: (id, patch) => runtime.updateSchedule(id, patch),
      pause: (id) => runtime.pauseSchedule(id),
      resume: (id) => runtime.resumeSchedule(id),
      delete: (id) => runtime.deleteSchedule(id),
      trigger: (id) => runtime.triggerSchedule(id),
      get: (id) => runtime.getSchedule(id),
      list: (query) => runtime.listSchedules(query),
    },
  }
}
