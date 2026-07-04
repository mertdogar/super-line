import { SuperLineError } from '@super-line/core'
import type { SuperLinePlugin, ServerStoreHandle } from '@super-line/server'
import { memoryStoreServer } from '@super-line/store-memory'
import type { moderationSurface } from './surface.js'

const MUTELIST = 'mod.muted'
const nameOf = (ctx: unknown): string => (ctx as { name?: string }).name ?? '?'

export interface ModerationConfig {
  /** Decides whether a connection may issue mod commands, from its auth ctx. App-supplied so the plugin stays role-agnostic. */
  isModerator: (ctx: unknown) => boolean
  /** Audit sink; defaults to console. */
  audit?: (line: string) => void
}

/**
 * A paired moderation plugin. The SERVER half:
 * - contributes a Store (the mutelist) — cluster-synced + persistent-capable for free;
 * - gates muted users' `send` via `use` middleware (the sanctioned interception seam — plugins never veto via taps);
 * - audits mutes/unmutes with an `onEvent` tap;
 * - serves the `mod.*` handlers its surface declares (subtracted from the host's `implement()`).
 */
export function moderation(cfg: ModerationConfig): SuperLinePlugin<typeof moderationSurface> {
  const audit = cfg.audit ?? ((line) => console.log(`[moderation] ${line}`))
  let muted: ServerStoreHandle | undefined // captured for the middleware, which has no PluginContext

  const requireMod = (ctx: unknown): void => {
    if (!cfg.isModerator(ctx)) throw new SuperLineError('FORBIDDEN', 'moderator role required')
  }

  return {
    name: 'moderation',
    stores: { [MUTELIST]: memoryStoreServer() },
    setup(ctx) {
      muted = ctx.store(MUTELIST)
    },
    use: [
      // sanctioned interception: reject a muted user's send. Plugins gate with `use`, never by mutating taps.
      async (ctx, info, next) => {
        if (info.kind === 'request' && info.name === 'send' && muted) {
          const name = nameOf(ctx)
          if (await muted.read(name)) throw new SuperLineError('FORBIDDEN', 'you are muted')
        }
        await next()
      },
    ],
    onEvent(e) {
      // mutes/unmutes surface as store writes/deletes on our own store — a node-local audit trail
      if (e.type === 'store.create' && e.store === MUTELIST) audit(`muted ${e.id}`)
      if (e.type === 'store.delete' && e.store === MUTELIST) audit(`unmuted ${e.id}`)
    },
    handlers: (pctx) => {
      const store = (): ServerStoreHandle => pctx.store(MUTELIST)
      // list() returns ResourceSummary rows (the server-side store-filtering surface); we just want the ids
      const list = async (): Promise<string[]> => (await store().list()).map((r) => r.id).sort()
      return {
        'mod.mute': async ({ user }, ctx) => {
          requireMod(ctx)
          if (!(await store().read(user))) await store().create(user, { by: nameOf(ctx), at: Date.now() }, {})
          pctx.toUser(user).emit('mod.status', { muted: true, by: nameOf(ctx) })
          return { muted: await list() }
        },
        'mod.unmute': async ({ user }, ctx) => {
          requireMod(ctx)
          if (await store().read(user)) await store().delete(user)
          pctx.toUser(user).emit('mod.status', { muted: false })
          return { muted: await list() }
        },
        'mod.list': async (_input, ctx) => {
          requireMod(ctx)
          return { muted: await list() }
        },
      }
    },
  }
}
