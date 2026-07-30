<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import DemoShell from './DemoShell.vue'

/* Tutorial 6's live result: one CRDT document ('board'), opened by TWO real clients.
   Edit different fields on both sides — the edits MERGE instead of clobbering. The
   footer buttons run the tutorial's exact concurrent-write test, and try an invalid
   write that the server's validate-before-commit refuses. */

type Board = { kind: string; title: string; color: string }
type Pane = { name: string; snap: Board | null; titleDraft: string; editing: boolean }

const COLORS = ['gray', 'blue', 'green', 'amber', 'rose']
const SWATCH: Record<string, string> = {
  gray: '#8c9aab',
  blue: '#60a5fa',
  green: '#4ade80',
  amber: '#fbbf24',
  rose: '#fb7185',
}

const status = ref<'booting' | 'live' | 'failed' | 'offline'>('booting')
const sysLine = ref('')
const invalidLine = ref('')
const panes = reactive<Record<string, Pane>>({
  ada: { name: 'ada', snap: null, titleDraft: '', editing: false },
  bob: { name: 'bob', snap: null, titleDraft: '', editing: false },
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const docs = new Map<string, any>()
const debounces = new Map<string, ReturnType<typeof setTimeout>>()
const cleanups: Array<() => void> = []

function render(name: string) {
  const pane = panes[name]!
  const doc = docs.get(name)
  if (!doc) return
  pane.snap = (doc.getSnapshot() as Board | undefined) ?? null
  if (!pane.editing) pane.titleDraft = pane.snap?.title ?? ''
}

onMounted(async () => {
  try {
    const [{ defineContract }, { z }, { createSuperLineServer }, { createSuperLineClient }, { createLoopbackTransport }, { crdtMemoryCollections, crdtCollectionsClient }] =
      await Promise.all([
        import('@super-line/core'),
        import('zod'),
        import('@super-line/server'),
        import('@super-line/client'),
        import('@super-line/transport-loopback'),
        import('@super-line/collections-crdt-memory'),
      ])

    // The tutorial's contract: concurrently-edited fields are tolerant (.catch),
    // `kind` is strict — written once at create, never concurrently overwritten.
    const contract = defineContract({
      collections: {
        scenes: {
          schema: z.object({
            kind: z.literal('board'),
            title: z.string().catch('untitled'),
            color: z.string().catch('gray'),
          }),
          crdt: { mode: 'document' },
        },
      },
      roles: { user: { clientToServer: {} } },
    })

    const loop = createLoopbackTransport()
    const srv = createSuperLineServer(contract, {
      transports: [loop.server],
      authenticate: (h) => {
        const name = h.query.name
        if (!name) throw new Error('unauthorized')
        return { role: 'user' as const, ctx: { name } }
      },
      crdtCollections: crdtMemoryCollections(),
      policies: {
        scenes: {
          read: () => true, // guard-shaped for CRDT docs (not a row filter)
          write: () => true,
        },
      },
    })
    cleanups.push(() => void srv.close())

    // Creation is server-authoritative — clients open, they can't create.
    await srv.collection('scenes').create('board', { kind: 'board', title: 'untitled', color: 'gray' })

    for (const name of ['ada', 'bob']) {
      const client = createSuperLineClient(contract, {
        transport: loop.client(),
        role: 'user',
        params: { name },
        crdtCollections: crdtCollectionsClient(),
      })
      cleanups.push(() => void client.close())
      const doc = client.collection('scenes').open('board')
      docs.set(name, doc)
      cleanups.push(() => doc.close())
      const off = doc.subscribe(() => render(name))
      cleanups.push(off)
      await doc.ready
      render(name)
    }

    status.value = 'live'
  } catch {
    status.value = 'failed'
  }
})

function typeTitle(name: string, value: string) {
  const pane = panes[name]!
  pane.editing = true
  pane.titleDraft = value
  clearTimeout(debounces.get(name))
  debounces.set(
    name,
    setTimeout(() => {
      pane.editing = false
      try {
        docs.get(name)?.update({ title: value })
      } catch {
        /* demo: a failed op just doesn't render */
      }
    }, 300),
  )
}

function pickColor(name: string, color: string) {
  try {
    docs.get(name)?.update({ color })
  } catch {
    /* demo: a failed op just doesn't render */
  }
}

async function concurrentTest() {
  if (status.value !== 'live') return
  const titles = ['Roadmap', 'Launch plan', 'Big board', 'Q3 canvas']
  const nextTitle = titles[Math.floor(Math.random() * titles.length)]!
  const nextColor = COLORS[Math.floor(Math.random() * COLORS.length)]!
  // The tutorial's beat: two clients, two DIFFERENT fields, the same instant.
  docs.get('ada')?.update({ title: nextTitle })
  docs.get('bob')?.update({ color: nextColor })
  await new Promise((r) => setTimeout(r, 350))
  const snap = docs.get('ada')?.getSnapshot() as Board | undefined
  sysLine.value = snap
    ? `both edits survived → { title: '${snap.title}', color: '${snap.color}' }`
    : 'still converging…'
}

async function invalidWrite() {
  if (status.value !== 'live') return
  try {
    // What TypeScript won't allow, the wire can still carry: break the strict field.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(docs.get('ada') as any)?.update({ kind: 'poster' })
  } catch {
    /* the reject may also surface locally — the snapshot check below still tells the story */
  }
  await new Promise((r) => setTimeout(r, 450))
  const snap = docs.get('bob')?.getSnapshot() as Board | undefined
  invalidLine.value =
    snap?.kind === 'board'
      ? "rejected — the server validated the post-merge doc against the schema and refused to commit; kind is still 'board' everywhere"
      : 'unexpectedly accepted?!'
}

onBeforeUnmount(() => {
  debounces.forEach((t) => clearTimeout(t))
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
    name="tutorial 6 · one document, two editors, merge not clobber"
    :status="status"
    real="a real CRDT document collection — real Yjs merge, real schema validation before every commit, opened by two real clients. In-tab substitution: the loopback wire; both 'tabs' live in this page."
  >
    <div class="cr-grid">
      <section v-for="pane in panes" :key="pane.name" class="cr-pane" :aria-label="pane.name + `'s view of the board`">
        <header class="cr-head">
          <span class="cr-who">{{ pane.name }}</span>
          <span
            class="cr-chip"
            :style="{ background: SWATCH[pane.snap?.color ?? 'gray'] ?? SWATCH.gray }"
            :title="'color: ' + (pane.snap?.color ?? '…')"
          />
        </header>
        <label class="cr-field">
          <span>title</span>
          <input
            :value="pane.titleDraft"
            class="ds-field"
            type="text"
            :disabled="status !== 'live'"
            :aria-label="'board title, edited as ' + pane.name"
            @input="typeTitle(pane.name, ($event.target as HTMLInputElement).value)"
            @focus="pane.editing = true"
            @blur="pane.editing = false"
          />
        </label>
        <div class="cr-colors" role="group" :aria-label="'board color, picked as ' + pane.name">
          <button
            v-for="color in COLORS"
            :key="color"
            class="cr-swatch"
            :class="{ active: pane.snap?.color === color }"
            type="button"
            :style="{ background: SWATCH[color] }"
            :disabled="status !== 'live'"
            :aria-label="color"
            @click="pickColor(pane.name, color)"
          />
        </div>
        <p class="cr-snap">{{ pane.snap ? JSON.stringify(pane.snap) : 'opening…' }}</p>
      </section>
    </div>

    <footer class="cr-foot">
      <button class="ds-btn ds-btn--primary" type="button" :disabled="status !== 'live'" @click="concurrentTest">
        run the concurrent-edit test
      </button>
      <button class="ds-btn" type="button" :disabled="status !== 'live'" @click="invalidWrite">
        try an invalid write (kind: 'poster')
      </button>
      <p v-if="sysLine" class="cr-sys" role="status">{{ sysLine }}</p>
      <p v-if="invalidLine" class="cr-invalid" role="status">{{ invalidLine }}</p>
    </footer>
  </DemoShell>
</template>

<style scoped>
.cr-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.cr-pane {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  padding: 0.7rem 0.85rem 0.8rem;
  min-width: 0;
}
.cr-pane + .cr-pane {
  border-left: 1px solid var(--sl-code-border);
}
.cr-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.cr-who {
  font-weight: 700;
  font-size: 0.86rem;
  color: var(--sl-code-fn);
}
.cr-chip {
  width: 16px;
  height: 16px;
  border-radius: 5px;
  border: 1px solid rgba(0, 0, 0, 0.25);
}
.cr-field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.cr-field span {
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  color: var(--sl-code-dim);
}
.cr-colors {
  display: flex;
  gap: 0.4rem;
}
.cr-swatch {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 2px solid transparent;
  cursor: pointer;
  transition: transform 0.12s, border-color 0.12s;
}
.cr-swatch:hover:not(:disabled) {
  transform: scale(1.08);
}
.cr-swatch.active {
  border-color: var(--sl-code-text);
}
.cr-swatch:focus-visible {
  outline: 2px solid var(--sl-cyan-bright);
  outline-offset: 2px;
}
.cr-swatch:disabled {
  opacity: 0.45;
  cursor: default;
}
.cr-snap {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  color: var(--sl-cyan-strong);
  overflow-wrap: anywhere;
}
.cr-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.65rem 0.85rem 0.75rem;
  border-top: 1px solid var(--sl-code-border);
  background: var(--sl-code-bg-2);
}
.cr-sys,
.cr-invalid {
  flex-basis: 100%;
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.73rem;
  overflow-wrap: anywhere;
}
.cr-sys {
  color: var(--sl-cyan-strong);
}
.cr-invalid {
  color: #f0b3a0;
}
@media (max-width: 640px) {
  .cr-grid {
    grid-template-columns: 1fr;
  }
  .cr-pane + .cr-pane {
    border-left: 0;
    border-top: 1px solid var(--sl-code-border);
  }
}
</style>
