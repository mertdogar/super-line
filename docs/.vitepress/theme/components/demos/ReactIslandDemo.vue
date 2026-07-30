<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import DemoShell from './DemoShell.vue'

/* Tutorial 3's live result: two REAL React apps (react-dom roots, StrictMode,
   @super-line/react hooks) mounted inside this Vue page, sharing one in-tab
   super-line server. The React source rendered on the page is the exact module
   running here — imported, not transcribed. */

const status = ref<'booting' | 'live' | 'failed' | 'offline'>('booting')
const adaEl = ref<HTMLElement | null>(null)
const bobEl = ref<HTMLElement | null>(null)
const cleanups: Array<() => void> = []

onMounted(async () => {
  try {
    const [{ createElement }, { createRoot }, { createSuperLineServer }, { createLoopbackTransport }, { memoryCollections }, { TodoTab }, { app }] =
      await Promise.all([
        import('react'),
        import('react-dom/client'),
        import('@super-line/server'),
        import('@super-line/transport-loopback'),
        import('@super-line/collections-memory'),
        import('../react/TodoTab'),
        import('../react/todos-contract'),
      ])

    const loop = createLoopbackTransport()
    const srv = createSuperLineServer(app, {
      transports: [loop.server],
      collections: memoryCollections(),
      authenticate: (h) => ({
        role: 'user' as const,
        ctx: { user: h.query.user ?? 'anon' },
      }),
      identify: (conn) => (conn.ctx as { user: string }).user,
      policies: {
        // Open for the demo: everyone reads the whole list, everyone writes.
        todos: { read: () => undefined, write: () => true },
      },
    })
    cleanups.push(() => void srv.close())
    await srv.collection('todos').insert({
      id: 'seed-1',
      text: 'toggle me in the other tab',
      done: false,
      createdAt: 1,
    })

    for (const [el, user] of [
      [adaEl.value, 'ada'],
      [bobEl.value, 'bob'],
    ] as const) {
      if (!el) continue
      const root = createRoot(el)
      root.render(createElement(TodoTab, { transport: loop.client(), user }))
      cleanups.push(() => root.unmount())
    }

    status.value = 'live'
  } catch {
    status.value = 'failed'
  }
})

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
    name="tutorial 3 · two React roots, one live row-set"
    :status="status"
    real="two real react-dom roots running the TodoTab component shown below — real StrictMode, real useSuperLineClient/useCollection, one real server with the todos collection. In-tab substitution: the loopback wire instead of WebSocket."
  >
    <div class="ri-grid">
      <div ref="adaEl" class="ri-mount" aria-label="Ada's React tab" />
      <div ref="bobEl" class="ri-mount" aria-label="Bob's React tab" />
    </div>
  </DemoShell>
</template>

<style scoped>
.ri-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.ri-mount {
  min-width: 0;
  min-height: 230px;
}
.ri-mount + .ri-mount {
  border-left: 1px solid var(--sl-code-border);
}

/* Styles for the React-rendered markup (class contract with TodoTab.tsx). */
.ri-mount :deep(.ri-tab) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 230px;
}
.ri-mount :deep(.ri-head) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.6rem 0.85rem;
}
.ri-mount :deep(.ri-head b) {
  font-size: 0.86rem;
  color: var(--sl-code-fn);
}
.ri-mount :deep(.ri-state) {
  font-family: var(--vp-font-family-mono);
  font-size: 0.71rem;
  color: var(--sl-cyan-strong);
}
.ri-mount :deep(.ri-list) {
  flex: 1;
  margin: 0;
  padding: 0.45rem 0.85rem;
  list-style: none;
  border-top: 1px solid var(--sl-code-border);
  overflow-y: auto;
  max-height: 190px;
}
.ri-mount :deep(.ri-list li) {
  margin: 0;
}
.ri-mount :deep(.ri-list label) {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.28rem 0;
  font-size: 0.84rem;
  color: var(--sl-code-text);
  cursor: pointer;
}
.ri-mount :deep(.ri-list label.is-done span) {
  text-decoration: line-through;
  color: var(--sl-code-dim);
}
.ri-mount :deep(.ri-list input[type='checkbox']) {
  accent-color: var(--sl-cyan-bright);
}
.ri-mount :deep(.ri-add) {
  display: flex;
  gap: 0.45rem;
  padding: 0.55rem 0.85rem 0.75rem;
  border-top: 1px solid var(--sl-code-border);
}
.ri-mount :deep(.ri-add .ds-field) {
  flex: 1;
}
@media (max-width: 640px) {
  .ri-grid {
    grid-template-columns: 1fr;
  }
  .ri-mount + .ri-mount {
    border-left: 0;
    border-top: 1px solid var(--sl-code-border);
  }
}
</style>
