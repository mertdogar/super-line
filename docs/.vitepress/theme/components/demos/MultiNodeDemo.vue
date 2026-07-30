<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import DemoShell from './DemoShell.vue'
import { DemoAdapter, SeverableBus } from './demo-bus'

/* Tutorial 7's live result: a real two-node super-line cluster in this tab. Each
   node is a full createSuperLineServer with its own adapter on one shared bus (the
   demo-bus.ts shown on the page — the same seam Redis implements). A reaction sent
   on any node fans out to its own clients AND crosses the bus to the far node.
   Sever the bus and cross-node delivery stops for real; intra-node keeps working. */

const EMOJI = ['🚀', '❤️', '🎉']
const NODES = [
  { id: 'a', label: 'node a', clients: ['a1', 'a2'] },
  { id: 'b', label: 'node b', clients: ['b1', 'b2'] },
] as const

type Burst = { id: number; emoji: string }

const status = ref<'booting' | 'live' | 'failed' | 'offline'>('booting')
const linked = ref(true)
const reactions = ref(0)
const crossed = ref(0)
const bursts = reactive<Record<string, Burst[]>>({ a1: [], a2: [], b1: [], b2: [] })

let burstSeq = 0
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clients = new Map<string, any>()
const cleanups: Array<() => void> = []
const bus = new SeverableBus()

function burst(laneId: string, emoji: string) {
  const id = burstSeq++
  bursts[laneId]!.push({ id, emoji })
  setTimeout(() => {
    const arr = bursts[laneId]!
    const at = arr.findIndex((b) => b.id === id)
    if (at >= 0) arr.splice(at, 1)
  }, 1000)
}

onMounted(async () => {
  try {
    const [{ defineContract }, { z }, { createSuperLineServer }, { createSuperLineClient }, { createLoopbackTransport }] =
      await Promise.all([
        import('@super-line/core'),
        import('zod'),
        import('@super-line/server'),
        import('@super-line/client'),
        import('@super-line/transport-loopback'),
      ])

    const contract = defineContract({
      shared: {
        serverToClient: {
          reactions: {
            payload: z.object({ emoji: z.string(), origin: z.string() }),
            subscribe: true,
          },
        },
      },
      roles: {
        user: {
          clientToServer: {
            react: { input: z.object({ emoji: z.string() }), output: z.void() },
          },
        },
      },
    })

    const node = () => {
      const loop = createLoopbackTransport()
      const srv = createSuperLineServer(contract, {
        transports: [loop.server],
        adapter: new DemoAdapter(bus), // ← the whole clustering story is this line
        authenticate: (h) => ({ role: 'user' as const, ctx: { client: h.query.client ?? '?' } }),
      })
      srv.implement({
        user: {
          react: async ({ emoji }, ctx) => {
            srv.publish('reactions', { emoji, origin: ctx.client })
          },
        },
      })
      cleanups.push(() => void srv.close())
      return loop
    }

    const loops = { a: node(), b: node() }
    const ready: Array<Promise<void>> = []
    for (const { id, clients: laneIds } of NODES) {
      for (const laneId of laneIds) {
        const client = createSuperLineClient(contract, {
          transport: loops[id].client(),
          role: 'user',
          params: { client: laneId },
        })
        clients.set(laneId, client)
        cleanups.push(() => void client.close())
        const sub = client.subscribe('reactions', (d: { emoji: string; origin: string }) => {
          burst(laneId, d.emoji)
        })
        ready.push(sub.ready)
        cleanups.push(() => sub.unsubscribe())
      }
    }
    await Promise.all(ready)
    status.value = 'live'
  } catch {
    status.value = 'failed'
  }
})

async function react(laneId: string, emoji: string) {
  if (status.value !== 'live') return
  reactions.value++
  if (linked.value) crossed.value++
  try {
    await clients.get(laneId).react({ emoji })
  } catch {
    /* demo: a failed publish just doesn't burst */
  }
}

function toggleBus() {
  linked.value = !linked.value
  bus.linked = linked.value
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
    name="tutorial 7 · two nodes, one adapter bus"
    :status="status"
    :status-text="status === 'live' ? (linked ? 'live · bus linked' : 'live · bus SEVERED') : undefined"
    real="two real createSuperLineServer nodes, four real subscribed clients, and a real Adapter implementation (demo-bus.ts, shown on this page) carrying the cross-node fan-out. In-tab substitution: the bus is an in-page object where production uses Redis/RabbitMQ/libp2p — same interface, same behavior."
  >
    <div class="mn-rig" :class="{ severed: !linked }">
      <section v-for="n in NODES" :key="n.id" class="mn-node" :aria-label="n.label">
        <header class="mn-bar">
          <span class="mn-name">{{ n.label }}</span>
          <span class="mn-adapter">adapter → shared bus</span>
        </header>
        <div v-for="laneId in n.clients" :key="laneId" class="mn-lane" :class="{ active: bursts[laneId]!.length > 0 }">
          <span class="mn-id"><i class="mn-pip" aria-hidden="true" />client {{ laneId }}</span>
          <span class="mn-track" aria-hidden="true">
            <span v-for="b in bursts[laneId]" :key="b.id" class="mn-spark">{{ b.emoji }}</span>
          </span>
          <span class="mn-keys" role="group" :aria-label="'react from client ' + laneId">
            <button
              v-for="e in EMOJI"
              :key="e"
              class="mn-key"
              type="button"
              :disabled="status !== 'live'"
              :aria-label="'react ' + e + ' from ' + laneId"
              @click="react(laneId, e)"
            >
              {{ e }}
            </button>
          </span>
        </div>
      </section>
    </div>

    <footer class="mn-foot">
      <button class="ds-btn" type="button" :aria-pressed="!linked" :disabled="status !== 'live'" @click="toggleBus">
        {{ linked ? '✂ sever the bus' : '⟲ reconnect the bus' }}
      </button>
      <span class="mn-stat"><b>{{ reactions }}</b> reactions</span>
      <span class="mn-stat"><b>{{ crossed }}</b> crossed the bus</span>
      <span v-if="!linked" class="mn-warn">cross-node delivery is down — each node still serves its own clients</span>
    </footer>
  </DemoShell>
</template>

<style scoped>
.mn-rig {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.7rem;
  padding: 0.75rem 0.85rem;
}
.mn-node {
  border: 1px solid var(--sl-code-border);
  border-radius: 10px;
  background: var(--sl-code-bg-2);
  overflow: hidden;
  min-width: 0;
}
.mn-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--sl-code-border);
}
.mn-name {
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  letter-spacing: 0.04em;
  color: var(--sl-code-fn);
}
.mn-adapter {
  font-family: var(--vp-font-family-mono);
  font-size: 0.66rem;
  color: var(--sl-cyan-strong);
  transition: color 0.2s;
}
.severed .mn-adapter {
  color: #ff8a72;
}
.mn-lane {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.55rem;
  padding: 0.55rem 0.75rem;
  transition: background-color 0.3s ease;
}
.mn-lane + .mn-lane {
  border-top: 1px solid var(--sl-code-border);
}
.mn-lane.active {
  background: color-mix(in oklab, var(--sl-cyan) 10%, transparent);
}
.mn-id {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  color: var(--sl-code-dim);
  white-space: nowrap;
}
.mn-pip {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #3a4654;
  transition: background-color 0.25s;
}
.mn-lane.active .mn-pip {
  background: var(--sl-cyan-bright);
}
.mn-track {
  position: relative;
  display: flex;
  gap: 0.3rem;
  justify-content: center;
  min-height: 20px;
}
.mn-spark {
  font-size: 15px;
  line-height: 1;
}
@media (prefers-reduced-motion: no-preference) {
  .mn-spark {
    animation: mn-spark 1s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  @keyframes mn-spark {
    0% { transform: translateY(7px) scale(0.5); opacity: 0; }
    22% { transform: translateY(0) scale(1.1); opacity: 1; }
    100% { transform: translateY(-9px) scale(0.9); opacity: 0; }
  }
}
.mn-keys {
  display: flex;
  gap: 0.28rem;
}
.mn-key {
  width: 30px;
  height: 28px;
  display: grid;
  place-items: center;
  font-size: 14px;
  line-height: 1;
  border: 1px solid var(--sl-code-border);
  border-radius: 7px;
  background: var(--sl-code-bg);
  cursor: pointer;
  transition: border-color 0.16s, background-color 0.16s, transform 0.1s;
}
.mn-key:hover:not(:disabled) {
  border-color: var(--sl-cyan);
  background: color-mix(in oklab, var(--sl-cyan) 12%, var(--sl-code-bg));
}
.mn-key:active:not(:disabled) {
  transform: scale(0.88);
}
.mn-key:focus-visible {
  outline: 2px solid var(--sl-cyan-bright);
  outline-offset: 2px;
}
.mn-key:disabled {
  opacity: 0.45;
  cursor: default;
}
.mn-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.7rem;
  padding: 0.6rem 0.85rem 0.7rem;
  border-top: 1px solid var(--sl-code-border);
  background: var(--sl-code-bg-2);
}
.mn-stat {
  font-family: var(--vp-font-family-mono);
  font-size: 0.73rem;
  color: var(--sl-code-dim);
}
.mn-stat b {
  color: var(--sl-code-text);
}
.mn-warn {
  font-family: var(--vp-font-family-mono);
  font-size: 0.71rem;
  color: #ff8a72;
}
@media (max-width: 640px) {
  .mn-rig {
    grid-template-columns: 1fr;
  }
}
</style>
