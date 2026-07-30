<script setup lang="ts">
import { onBeforeUnmount, reactive, ref } from 'vue'
import DemoShell from './DemoShell.vue'

/* Tutorial 1's live result: a REAL super-line server booted in this tab, showing its
   own LogTape diagnostics. The contract is the same one the page builds; the wire is
   the loopback transport standing in for WebSocket (the pluggable-transport point).
   The "probe" is a peek at Tutorial 2: one real client connecting and calling join. */

type LogLine = { id: number; level: string; category: string; text: string }

const status = ref<'booting' | 'live' | 'failed' | 'offline'>('offline')
const probeConnected = ref(false)
const probeResult = ref('')
const lines = reactive<LogLine[]>([])
const paneEl = ref<HTMLElement | null>(null)

let seq = 0
let busy = false
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loop: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let contract: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let probe: any
const cleanups: Array<() => void> = []

function push(level: string, category: string, text: string) {
  lines.push({ id: seq++, level, category, text })
  if (lines.length > 200) lines.splice(0, lines.length - 200)
  requestAnimationFrame(() => {
    const el = paneEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

async function boot() {
  if (busy || status.value === 'live') return
  busy = true
  status.value = 'booting'
  try {
    const [{ configureSync }, { defineContract }, { z }, { createSuperLineServer }, { createLoopbackTransport }] =
      await Promise.all([
        import('@logtape/logtape'),
        import('@super-line/core'),
        import('zod'),
        import('@super-line/server'),
        import('@super-line/transport-loopback'),
      ])

    // Feed super-line's real internal logging into the pane below — trace and up.
    configureSync({
      reset: true,
      sinks: {
        pane: (record) => {
          const text = record.message
            .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
            .join('')
          push(record.level, record.category.slice(1).join('.'), text)
        },
      },
      loggers: [
        { category: ['super-line'], lowestLevel: 'trace', sinks: ['pane'] },
        { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: [] },
      ],
    })

    // The exact contract this page builds in src/contract.ts.
    const c = defineContract({
      shared: {
        clientToServer: {
          join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
        },
        serverToClient: {
          message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) },
          presence: { payload: z.object({ room: z.string(), count: z.number() }), subscribe: true },
        },
      },
      roles: {
        user: {
          clientToServer: {
            send: { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) },
          },
        },
      },
    })

    contract = c
    loop = createLoopbackTransport()
    const srv = createSuperLineServer(c, {
      transports: [loop.server],
      authenticate: (h) => {
        const name = h.query.name
        if (!name) throw new Error('unauthorized')
        return { role: 'user' as const, ctx: { name } }
      },
    })
    srv.implement({
      shared: {
        join: async ({ room }, _ctx, conn) => {
          srv.room(room).add(conn)
          srv.publish('presence', { room, count: srv.room(room).size })
          return { ok: true }
        },
      },
      user: {
        send: async ({ room, text }, ctx) => {
          srv.room(room).broadcast('message', { room, text, from: ctx.name })
          return { id: globalThis.crypto.randomUUID() }
        },
      },
    })
    cleanups.push(() => void srv.close())

    push('info', 'tutorial', 'server booted — listening on the in-tab loopback wire')
    status.value = 'live'
  } catch {
    status.value = 'failed'
  } finally {
    busy = false
  }
}

async function connectProbe() {
  if (busy || status.value !== 'live' || probeConnected.value) return
  busy = true
  try {
    const { createSuperLineClient } = await import('@super-line/client')
    probe = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      params: { name: 'probe' },
    })
    cleanups.push(() => void probe?.close())
    probeConnected.value = true
    probeResult.value = 'probe connected as role user'
  } catch (err) {
    probeResult.value = String(err)
  } finally {
    busy = false
  }
}

async function probeJoin() {
  if (busy || !probeConnected.value) return
  busy = true
  try {
    const res = await probe.join({ room: 'lobby' })
    probeResult.value = `join('lobby') → ${JSON.stringify(res)} — a typed response`
  } catch (err) {
    probeResult.value = String(err)
  } finally {
    busy = false
  }
}

function disconnectProbe() {
  if (!probeConnected.value) return
  void probe?.close()
  probe = undefined
  probeConnected.value = false
  probeResult.value = 'probe disconnected'
}

onBeforeUnmount(() => {
  cleanups.forEach((fn) => {
    try {
      fn()
    } catch {
      /* best-effort teardown */
    }
  })
})
</script>

<template>
  <DemoShell
    name="tutorial 1 · a live server in this tab"
    :status="status"
    :status-text="status === 'offline' ? 'not booted yet' : undefined"
    real="a real createSuperLineServer with your contract, its actual LogTape diagnostics, real validation. In-tab substitution: the loopback transport carries the bytes instead of WebSocket — the server code is identical on both wires."
  >
    <div class="sb-controls">
      <button class="ds-btn ds-btn--primary" type="button" :disabled="status !== 'offline'" @click="boot">
        ▶ boot the server
      </button>
      <span class="sb-sep" aria-hidden="true" />
      <button class="ds-btn" type="button" :disabled="status !== 'live' || probeConnected" @click="connectProbe">
        connect a probe client
      </button>
      <button class="ds-btn" type="button" :disabled="!probeConnected" @click="probeJoin">
        call join('lobby')
      </button>
      <button class="ds-btn" type="button" :disabled="!probeConnected" @click="disconnectProbe">
        disconnect
      </button>
    </div>

    <p v-if="probeResult" class="sb-result" role="status">{{ probeResult }}</p>

    <div ref="paneEl" class="sb-pane" role="log" aria-live="polite" aria-label="Server log stream">
      <p v-if="lines.length === 0" class="sb-empty">
        server logs will stream here — press <b>boot the server</b>
      </p>
      <div v-for="l in lines" :key="l.id" class="sb-line" :class="'lvl-' + l.level">
        <span class="sb-lvl">{{ l.level }}</span>
        <span class="sb-cat">{{ l.category }}</span>
        <span class="sb-msg">{{ l.text }}</span>
      </div>
    </div>
  </DemoShell>
</template>

<style scoped>
.sb-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem;
  padding: 0.75rem 0.9rem;
}
.sb-sep {
  width: 1px;
  height: 1.2rem;
  background: var(--sl-code-border);
}
.sb-result {
  margin: 0;
  padding: 0 0.95rem 0.55rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  color: var(--sl-cyan-strong);
  overflow-wrap: anywhere;
}
.sb-pane {
  height: 240px;
  overflow-y: auto;
  padding: 0.7rem 0.95rem 0.9rem;
  border-top: 1px solid var(--sl-code-border);
  font-family: var(--vp-font-family-mono);
  font-size: 0.73rem;
  line-height: 1.65;
}
.sb-empty {
  margin: auto;
  padding-top: 5rem;
  text-align: center;
  color: var(--sl-code-dim);
  font-size: 0.78rem;
}
.sb-empty b {
  color: var(--sl-code-text);
}
.sb-line {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
}
.sb-lvl {
  flex: none;
  width: 3.2em;
  color: var(--sl-code-dim);
}
.lvl-info .sb-lvl { color: var(--sl-cyan-bright); }
.lvl-warning .sb-lvl, .lvl-error .sb-lvl { color: #f0b3a0; }
.sb-cat {
  flex: none;
  color: var(--sl-code-key);
}
.sb-msg {
  color: var(--sl-code-text);
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .sb-cat { display: none; }
}
</style>
