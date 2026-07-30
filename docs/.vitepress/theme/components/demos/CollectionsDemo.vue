<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import DemoShell from './DemoShell.vue'

/* Tutorial 4's live result: a private `notes` collection behind real row-level
   security (read scoped to the owner, write guarded), served from a memory backend.
   The showpiece: STOP the server, boot a brand-new one on the SAME backend, and the
   rows come back — the backend owns the data; servers are replaceable. */

type Note = { id: string; ownerId: string; text: string; createdAt: number }
type Pane = { name: string; rows: Note[]; draft: string }

const status = ref<'booting' | 'live' | 'failed' | 'offline'>('booting')
const serverGen = ref(0)
const sysLine = ref('')
const forgeResult = ref('')
const panes = reactive<Record<string, Pane>>({
  ada: { name: 'ada', rows: [], draft: '' },
  bob: { name: 'bob', rows: [], draft: '' },
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mods: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let contract: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let backend: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clients = new Map<string, any>()
let generationCleanups: Array<() => void> = []

async function bootServer() {
  const { createSuperLineServer, createSuperLineClient, createLoopbackTransport, eq } = mods
  const loop = createLoopbackTransport()
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    collections: backend, // the SAME backend instance across server generations
    authenticate: (h: { query: Record<string, string> }) => ({
      role: 'user' as const,
      ctx: { user: h.query.user ?? 'anon' },
    }),
    identify: (conn: { ctx: { user: string } }) => conn.ctx.user,
    policies: {
      notes: {
        read: (principal: string) => eq('ownerId', principal), // you only ever SEE your own rows
        write: (principal: string, op: string, next?: Note, prev?: Note) =>
          op === 'delete' ? prev?.ownerId === principal : next?.ownerId === principal,
      },
    },
  })
  generationCleanups.push(() => void srv.close())

  for (const name of ['ada', 'bob']) {
    const client = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      params: { user: name },
    })
    clients.set(name, client)
    generationCleanups.push(() => void client.close())
    const pane = panes[name]!
    const sub = client.collection('notes').subscribe({ orderBy: [{ field: 'createdAt', dir: 'asc' }] })
    generationCleanups.push(() => sub.close())
    const render = () => {
      pane.rows = [...(sub.rows() as Note[])]
    }
    sub.subscribe(render)
    await sub.ready
    render()
  }
  serverGen.value++
  status.value = 'live'
}

onMounted(async () => {
  try {
    const [{ defineContract, eq }, { z }, srvMod, cliMod, loopMod, { memoryCollections }] = await Promise.all([
      import('@super-line/core'),
      import('zod'),
      import('@super-line/server'),
      import('@super-line/client'),
      import('@super-line/transport-loopback'),
      import('@super-line/collections-memory'),
    ])
    mods = {
      eq,
      createSuperLineServer: srvMod.createSuperLineServer,
      createSuperLineClient: cliMod.createSuperLineClient,
      createLoopbackTransport: loopMod.createLoopbackTransport,
    }
    contract = defineContract({
      collections: {
        notes: {
          schema: z.object({
            id: z.string(),
            ownerId: z.string(),
            text: z.string(),
            createdAt: z.number(),
          }),
          key: 'id',
        },
      },
      roles: { user: { clientToServer: {} } },
    })
    backend = memoryCollections()
    await bootServer()
    sysLine.value = 'server #1 is live — each side sees only its own rows'
  } catch {
    status.value = 'failed'
  }
})

async function add(name: string) {
  const pane = panes[name]!
  const text = pane.draft.trim()
  if (!text || status.value !== 'live') return
  pane.draft = ''
  try {
    await clients.get(name).collection('notes').insert({
      id: globalThis.crypto.randomUUID(),
      ownerId: name,
      text,
      createdAt: Date.now(),
    })
  } catch {
    /* demo: a failed op just doesn't render */
  }
}

async function forge() {
  if (status.value !== 'live') return
  try {
    // Ada tries to plant a row owned by bob — the write policy must refuse it.
    await clients.get('ada').collection('notes').insert({
      id: globalThis.crypto.randomUUID(),
      ownerId: 'bob',
      text: 'forged!',
      createdAt: Date.now(),
    })
    forgeResult.value = 'unexpectedly accepted?!'
  } catch (err) {
    const e = err as { code?: string; message?: string }
    forgeResult.value = `rejected — ${e.code ?? 'error'}: the write policy requires ownerId === principal`
  }
}

function stopServer() {
  if (status.value !== 'live') return
  generationCleanups.forEach((fn) => {
    try {
      fn()
    } catch {
      /* best-effort teardown */
    }
  })
  generationCleanups = []
  clients.clear()
  status.value = 'offline'
  sysLine.value = `server #${serverGen.value} stopped. The backend object still holds every row.`
}

async function reboot() {
  if (status.value !== 'offline') return
  status.value = 'booting'
  try {
    await bootServer()
    sysLine.value = `server #${serverGen.value} booted on the SAME backend — fresh clients resubscribed, rows intact`
  } catch {
    status.value = 'failed'
  }
}

onBeforeUnmount(stopServer)
</script>

<template>
  <DemoShell
    name="tutorial 4 · a secured collection that outlives its server"
    :status="status"
    :status-text="status === 'live' ? `live · server #${serverGen}` : undefined"
    real="a real notes collection with real deny-by-default policies — the cross-user read fence and the rejected forged write are enforced by the server, not the UI. In-tab substitutions: the loopback wire, and the memory backend standing in for SQLite/Postgres (same seam, same behavior)."
  >
    <div class="cl-grid">
      <section v-for="pane in panes" :key="pane.name" class="cl-pane" :aria-label="'client ' + pane.name">
        <header class="cl-head">
          <span class="cl-who">{{ pane.name }}</span>
          <span class="cl-count">{{ pane.rows.length }} row{{ pane.rows.length === 1 ? '' : 's' }} · only {{ pane.name }}'s</span>
        </header>
        <ul class="cl-list">
          <li v-if="pane.rows.length === 0" class="cl-empty">no notes yet</li>
          <li v-for="row in pane.rows" :key="row.id">{{ row.text }}</li>
        </ul>
        <form class="cl-add" @submit.prevent="add(pane.name)">
          <input
            v-model="pane.draft"
            class="ds-field"
            type="text"
            :placeholder="'private note as ' + pane.name"
            :aria-label="'private note as ' + pane.name"
            :disabled="status !== 'live'"
          />
          <button class="ds-btn ds-btn--primary" type="submit" :disabled="status !== 'live' || !pane.draft.trim()">
            add
          </button>
        </form>
      </section>
    </div>

    <footer class="cl-foot">
      <div class="cl-actions">
        <button class="ds-btn" type="button" :disabled="status !== 'live'" @click="forge">
          ada, forge a row as bob
        </button>
        <span class="cl-sep" aria-hidden="true" />
        <button v-if="status === 'live'" class="ds-btn" type="button" @click="stopServer">■ stop the server</button>
        <button v-else class="ds-btn ds-btn--primary" type="button" :disabled="status !== 'offline'" @click="reboot">
          ▶ boot a NEW server on the same backend
        </button>
      </div>
      <p v-if="forgeResult" class="cl-forge" role="status">{{ forgeResult }}</p>
      <p v-if="sysLine" class="cl-sys" role="status">{{ sysLine }}</p>
    </footer>
  </DemoShell>
</template>

<style scoped>
.cl-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.cl-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.cl-pane + .cl-pane {
  border-left: 1px solid var(--sl-code-border);
}
.cl-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.6rem 0.85rem;
}
.cl-who {
  font-weight: 700;
  font-size: 0.86rem;
  color: var(--sl-code-fn);
}
.cl-count {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  color: var(--sl-code-dim);
}
.cl-list {
  flex: 1;
  margin: 0;
  padding: 0.5rem 0.85rem;
  list-style: none;
  border-top: 1px solid var(--sl-code-border);
  height: 150px;
  overflow-y: auto;
}
.cl-list li {
  margin: 0;
  padding: 0.22rem 0;
  font-size: 0.84rem;
  color: var(--sl-code-text);
  overflow-wrap: anywhere;
}
.cl-empty {
  color: var(--sl-code-dim);
  font-size: 0.78rem;
}
.cl-add {
  display: flex;
  gap: 0.45rem;
  padding: 0.55rem 0.85rem 0.75rem;
  border-top: 1px solid var(--sl-code-border);
}
.cl-add .ds-field {
  flex: 1;
}
.cl-foot {
  padding: 0.65rem 0.85rem 0.75rem;
  border-top: 1px solid var(--sl-code-border);
  background: var(--sl-code-bg-2);
}
.cl-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.cl-sep {
  width: 1px;
  height: 1.2rem;
  background: var(--sl-code-border);
}
.cl-forge {
  margin: 0.5rem 0 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.73rem;
  color: #f0b3a0;
  overflow-wrap: anywhere;
}
.cl-sys {
  margin: 0.5rem 0 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.73rem;
  color: var(--sl-cyan-strong);
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .cl-grid {
    grid-template-columns: 1fr;
  }
  .cl-pane + .cl-pane {
    border-left: 0;
    border-top: 1px solid var(--sl-code-border);
  }
}
</style>
