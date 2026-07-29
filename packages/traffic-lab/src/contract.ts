import * as z from 'zod'
import { defineContract } from '@super-line/core'

/**
 * The traffic zoo: one contract exercising every wire pattern super-line has, so each phase of a run
 * isolates exactly one fan-out path (PLAN decision 4).
 *
 * Every app payload carries `op` — a run-unique monotonic id — and `phase`. That is what lets the
 * analyzer thread one operation through all four tap layers: what the app asked for, what was
 * published, which nodes it arrived at (and which accepted it), and which clients consumed it.
 */
export const op = z.object({ op: z.number(), phase: z.number(), from: z.string() })
export type Op = z.infer<typeof op>

const ok = z.object({ ok: z.boolean() })

export const lab = defineContract({
  collections: {
    /** LWW rows — exercises the single global `cbatch` relay channel and permissive row routing. */
    rows: {
      schema: z.object({ id: z.string(), bucket: z.string(), n: z.number(), op: z.number() }),
      key: 'id',
    },
    /**
     * A CRDT document collection — exercises the per-document `d:<n>:<id>` channels. Presence-tolerant
     * by ADR-0008: validate-before-commit must never require a field a concurrent merge may transiently drop.
     */
    docs: {
      schema: z.object({
        title: z.string().catch(''),
        cells: z.record(z.string(), z.number()).catch({}),
      }),
      crdt: { mode: 'document' },
    },
  },
  shared: {
    serverToClient: {
      /**
       * The server↔server cluster bus. Deliberately subscribed by NO client — only `srv.subscribe`
       * on each node — so phase 5 measures the bus alone, uncontaminated by client fan-out.
       */
      stats: { payload: op, subscribe: true },
      /**
       * Targeted server→client event (`toConn().emit`) and room broadcast. Both live in `shared`
       * because that is the only surface `Room.broadcast` and `ConnTarget.emit` can address — they
       * fan out across roles, so a role-scoped event would have no meaning at the far end.
       */
      direct: { payload: op },
      roomMsg: { payload: op },
    },
  },
  roles: {
    user: {
      clientToServer: {
        /** Baseline unicast: should produce no cross-node traffic whatsoever. */
        ping: { input: op, output: z.object({ ok: z.boolean(), node: z.string() }) },
        /** How a client learns its own connection id, which the conductor then hands out as a phase target. */
        whoami: { input: z.object({}), output: z.object({ connId: z.string(), node: z.string() }) },
        /** Drives `srv.toConn(target).emit` — the local-vs-remote contrast of phase 2. */
        emitTo: { input: op.extend({ target: z.string() }), output: ok },
        joinRoom: { input: z.object({ room: z.string() }), output: ok },
        leaveRoom: { input: z.object({ room: z.string() }), output: ok },
        /** Drives `srv.room(room).broadcast` — the all-local vs spread contrast of phase 3. */
        broadcastRoom: { input: op.extend({ room: z.string() }), output: ok },
        /** Drives `srv.forRole('user').publish('announce', …)`. */
        publishTopic: { input: op, output: ok },
        /** Drives `srv.publish('stats', …)` — the cluster bus. */
        busPublish: { input: op, output: ok },
      },
      serverToClient: {
        /** A client-facing topic — the only server→client surface here that is genuinely role-scoped. */
        announce: { payload: op, subscribe: true },
      },
    },
  },
})

export type Lab = typeof lab
