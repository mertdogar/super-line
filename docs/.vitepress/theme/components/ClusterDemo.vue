<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'

// A real super-line cluster, in one browser tab. Two server nodes joined by one
// adapter bus; each node hosts two subscriber clients over the loopback transport.
// A reaction published on any node fans out to that node's other client
// (intra-node) and crosses the bus to the far node's clients (cross-node).
// Sever the bus and cross-node delivery stops for real — intra-node keeps working.

const EMOJI = ['🚀', '❤️', '🎉']
const NODES = [
  { id: 'a', label: 'node a', clients: ['a1', 'a2'] },
  { id: 'b', label: 'node b', clients: ['b1', 'b2'] },
] as const

type Burst = { id: number; emoji: string; x: number }

const ready = ref(false)
const linked = ref(true)
const reactions = ref(0)
const crossed = ref(0)
const flow = ref<'ab' | 'ba' | null>(null)
const bursts = reactive<Record<string, Burst[]>>({ a1: [], a2: [], b1: [], b2: [] })

let reduceMotion = false
let burstSeq = 0
let flowTimer: ReturnType<typeof setTimeout> | undefined
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clients = new Map<string, any>()
const cleanups: Array<() => void> = []

// A partitionable in-process bus implementing core's Adapter contract. Each node
// gets one adapter (shared by its two clients), so "same node" === "same adapter":
// when severed we still deliver a publish back to its source adapter (intra-node)
// but not to the other node's adapter (cross-node). This is a faithful use of the
// pluggable adapter seam — the same interface Redis/libp2p implement.
class DemoBus {
  channels = new Map<string, Set<DemoAdapter>>()
  linked = true
  subscribe(ch: string, a: DemoAdapter) {
    let s = this.channels.get(ch)
    if (!s) this.channels.set(ch, (s = new Set()))
    s.add(a)
  }
  unsubscribe(ch: string, a: DemoAdapter) {
    const s = this.channels.get(ch)
    if (!s) return
    s.delete(a)
    if (!s.size) this.channels.delete(ch)
  }
  publish(ch: string, payload: string | Uint8Array, src: DemoAdapter) {
    const s = this.channels.get(ch)
    if (!s) return
    for (const a of s) {
      if (!this.linked && a !== src) continue // severed: source node only
      a.deliver(ch, payload)
    }
  }
}
class DemoAdapter {
  handler?: (ch: string, p: string | Uint8Array) => void
  constructor(private bus: DemoBus) {}
  subscribe(ch: string) {
    this.bus.subscribe(ch, this)
  }
  unsubscribe(ch: string) {
    this.bus.unsubscribe(ch, this)
  }
  publish(ch: string, p: string | Uint8Array) {
    this.bus.publish(ch, p, this)
  }
  onMessage(h: (ch: string, p: string | Uint8Array) => void) {
    this.handler = h
  }
  deliver(ch: string, p: string | Uint8Array) {
    this.handler?.(ch, p)
  }
}

let demoBus: DemoBus

function burst(stageId: string, emoji: string) {
  const id = burstSeq++
  const x = 12 + Math.random() * 66
  bursts[stageId].push({ id, emoji, x })
  setTimeout(() => {
    const arr = bursts[stageId]
    const i = arr.findIndex((b) => b.id === id)
    if (i >= 0) arr.splice(i, 1)
  }, 1000)
}

// A reaction landed on this client. If it came from the other node it crossed the
// bus — delay the burst slightly so it lands after the signal sweeps the wire.
function onReaction(stageId: string, d: { emoji: string; origin: string }) {
  const crossedHere = stageId[0] !== d.origin[0]
  const delay = crossedHere && !reduceMotion ? 200 : 0
  if (delay) setTimeout(() => burst(stageId, d.emoji), delay)
  else burst(stageId, d.emoji)
}

async function react(stageId: string, emoji: string) {
  if (!ready.value) return
  const client = clients.get(stageId)
  if (!client) return
  reactions.value++
  if (linked.value) {
    crossed.value++
    flow.value = stageId[0] === 'a' ? 'ab' : 'ba'
    clearTimeout(flowTimer)
    flowTimer = setTimeout(() => (flow.value = null), 720)
  }
  try {
    await client.react({ emoji })
  } catch {
    // demo: a failed publish just doesn't burst
  }
}

function toggleBus() {
  linked.value = !linked.value
  demoBus.linked = linked.value
}

function reset() {
  reactions.value = 0
  crossed.value = 0
}

onMounted(async () => {
  reduceMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

  const { defineContract } = await import('@super-line/core')
  const { z } = await import('zod')
  const { createSuperLineServer } = await import('@super-line/server')
  const { createSuperLineClient } = await import('@super-line/client')
  const { createLoopbackTransport } = await import('@super-line/transport-loopback')

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

  demoBus = new DemoBus()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const node = (loopback: any) => {
    const srv = createSuperLineServer(contract, {
      transports: [loopback.server],
      adapter: new DemoAdapter(demoBus),
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
    return { srv, loopback }
  }

  const loopA = createLoopbackTransport()
  const loopB = createLoopbackTransport()
  const nodes = { a: node(loopA), b: node(loopB) }

  const subs: Array<Promise<void>> = []
  for (const { id, clients: ids } of NODES) {
    for (const stageId of ids) {
      const client = createSuperLineClient(contract, {
        transport: nodes[id].loopback.client(),
        role: 'user',
        params: { client: stageId },
      })
      clients.set(stageId, client)
      const sub = client.subscribe('reactions', (d: { emoji: string; origin: string }) =>
        onReaction(stageId, d),
      )
      subs.push(sub.ready)
      cleanups.push(() => sub.unsubscribe())
      cleanups.push(() => void client.close())
    }
  }

  await Promise.all(subs)
  ready.value = true
})

onBeforeUnmount(() => {
  clearTimeout(flowTimer)
  cleanups.forEach((fn) => {
    try {
      fn()
    } catch {
      /* teardown best-effort */
    }
  })
})
</script>

<template>
  <section class="cd" aria-labelledby="cd-title">
    <div class="cd-head">
      <h2 id="cd-title" class="cd-title">Two nodes, one bus</h2>
      <p class="cd-sub">
        A real super-line cluster, running in this tab: two server nodes joined by one adapter, two
        subscriber clients each. React on any client — it fans out to that node's other client and
        <strong>crosses the bus</strong> to the far node. <strong>Sever the bus</strong> and
        cross-node delivery stops dead, while each node keeps serving its own.
      </p>
    </div>

    <div class="cd-rig" :class="{ severed: !linked, ready }">
      <template v-for="(n, ni) in NODES" :key="n.id">
        <section class="cd-node" :aria-label="n.label">
          <header class="cd-node__bar">
            <svg class="cd-glyph" viewBox="0 0 30 12" aria-hidden="true">
              <path d="M0 6 H7 l2.4 -5 l2.6 9 l2.2 -6 H30" />
            </svg>
            <span class="cd-node__name">{{ n.label }}</span>
          </header>
          <div class="cd-lanes">
            <div
              v-for="cid in n.clients"
              :key="cid"
              class="cd-lane"
              :class="{ active: bursts[cid].length > 0 }"
            >
              <span class="cd-lane__id"><span class="cd-pip" />client {{ cid }}</span>
              <div class="cd-track" aria-hidden="true">
                <span
                  v-for="b in bursts[cid]"
                  :key="b.id"
                  class="cd-spark"
                  :style="{ left: b.x + '%' }"
                  >{{ b.emoji }}</span
                >
              </div>
              <div class="cd-keys" role="group" :aria-label="'React from client ' + cid">
                <button
                  v-for="e in EMOJI"
                  :key="e"
                  class="cd-key"
                  type="button"
                  :disabled="!ready"
                  :aria-label="'React ' + e + ' from client ' + cid"
                  @click="react(cid, e)"
                >
                  {{ e }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <div
          v-if="ni === 0"
          class="cd-bus"
          :class="[flow ? 'flow-' + flow : '', { severed: !linked }]"
        >
          <svg class="cd-wave" viewBox="0 0 220 140" preserveAspectRatio="none" aria-hidden="true">
            <path class="cd-wave__base" d="M4 70 H30 l5 -20 l6 34 l5 -14 H190 l5 -20 l6 34 l5 -14 H216" />
            <path class="cd-wave__live" d="M4 70 H30 l5 -20 l6 34 l5 -14 H190 l5 -20 l6 34 l5 -14 H216" />
            <line class="cd-wave__flat" x1="4" y1="70" x2="216" y2="70" />
          </svg>
          <span class="cd-blip" aria-hidden="true" />
          <button
            class="cd-sever"
            type="button"
            :aria-pressed="!linked"
            :disabled="!ready"
            @click="toggleBus"
          >
            {{ linked ? 'sever bus' : 'reconnect' }}
          </button>
        </div>
      </template>
    </div>

    <footer class="cd-status">
      <span class="cd-live" :class="{ off: !ready }"><span class="cd-live-dot" />live</span>
      <span class="cd-sep">·</span>
      <span class="cd-stat">2 nodes · 4 subscribers</span>
      <span class="cd-sep">·</span>
      <span class="cd-stat"><b>{{ reactions }}</b> reaction{{ reactions === 1 ? '' : 's' }}</span>
      <span class="cd-sep">·</span>
      <span class="cd-stat"><b>{{ crossed }}</b> crossed the bus</span>
      <button class="cd-reset" type="button" :disabled="!ready" @click="reset">Reset</button>
    </footer>
  </section>
</template>

<style scoped>
/* The widget is an instrument: always dark, so the cyan signal sings in both
   themes — consistent with how the page renders every code window. */
.cd {
  --bg: #0c0f14;
  --bg-2: #11161e;
  --bg-3: #151c26;
  --line: #1d242e;
  --ink: #c9d4e3;
  --dim: #8c9aab;
  --sig: #22d3ee;
  --sig-soft: rgba(34, 211, 238, 0.16);
  --sig-glow: rgba(34, 211, 238, 0.55);
  max-width: 1120px;
  margin: 0 auto;
  padding: 8px 24px 0;
}

.cd-head {
  max-width: 60ch;
  margin: 0 auto 40px;
  text-align: center;
}
.cd-title {
  margin: 0 0 14px;
  font-size: clamp(1.7rem, 4vw, 2.35rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.15;
  text-wrap: balance;
  border: 0;
  color: var(--vp-c-text-1);
}
.cd-sub {
  margin: 0;
  font-size: 16px;
  line-height: 1.65;
  color: var(--vp-c-text-2);
  text-wrap: pretty;
}
.cd-sub strong {
  color: var(--vp-c-text-1);
  font-weight: 600;
}

/* ── the rig ──────────────────────────────────────────────────────── */
.cd-rig {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(150px, 18vw, 210px) minmax(0, 1fr);
  align-items: stretch;
  max-width: 900px;
  margin: 0 auto;
  padding: 14px;
  border-radius: 16px;
  background: var(--bg);
  border: 1px solid var(--line);
  box-shadow:
    0 24px 60px -28px rgba(2, 12, 20, 0.7),
    0 2px 10px -4px rgba(2, 12, 20, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.02);
  opacity: 0.6;
  transition: opacity 0.5s ease;
}
.cd-rig.ready {
  opacity: 1;
}

/* ── node panel ───────────────────────────────────────────────────── */
.cd-node {
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  overflow: hidden;
}
.cd-node__bar {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 14px;
  background: var(--bg-3);
  border-bottom: 1px solid var(--line);
}
.cd-glyph {
  width: 30px;
  height: 12px;
  flex: none;
}
.cd-glyph path {
  fill: none;
  stroke: var(--sig);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.85;
}
.cd-node__name {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  letter-spacing: 0.05em;
  color: var(--ink);
}

.cd-lanes {
  display: flex;
  flex-direction: column;
}
.cd-lane {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  transition: background-color 0.3s ease;
}
.cd-lane + .cd-lane {
  border-top: 1px solid var(--line);
}
.cd-lane.active {
  background: var(--sig-soft);
}
.cd-lane__id {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  letter-spacing: 0.02em;
  color: var(--dim);
  white-space: nowrap;
}
.cd-pip {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #3a4654;
  transition:
    background-color 0.25s ease,
    box-shadow 0.25s ease;
}
.cd-lane.active .cd-pip {
  background: var(--sig);
  box-shadow: 0 0 8px 1px var(--sig-glow);
}

/* the receiving track — a thin signal strip, never a big empty box */
.cd-track {
  position: relative;
  height: 24px;
  min-width: 24px;
  border-radius: 6px;
  overflow: hidden;
}
.cd-track::before {
  content: '';
  position: absolute;
  inset: 50% 4px auto;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--line) 18%, var(--line) 82%, transparent);
}
.cd-spark {
  position: absolute;
  bottom: 1px;
  font-size: 15px;
  line-height: 1;
  transform: translateX(-50%);
  filter: drop-shadow(0 0 5px var(--sig-glow));
  animation: cd-spark 1s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
@keyframes cd-spark {
  0% {
    transform: translate(-50%, 8px) scale(0.5);
    opacity: 0;
  }
  22% {
    transform: translate(-50%, 0) scale(1.1);
    opacity: 1;
  }
  100% {
    transform: translate(-50%, -12px) scale(0.9);
    opacity: 0;
  }
}

.cd-keys {
  display: flex;
  gap: 5px;
}
.cd-key {
  width: 30px;
  height: 28px;
  display: grid;
  place-items: center;
  font-size: 14px;
  line-height: 1;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  cursor: pointer;
  transition:
    border-color 0.16s,
    background-color 0.16s,
    transform 0.1s cubic-bezier(0.16, 1, 0.3, 1);
}
.cd-key:hover:not(:disabled) {
  border-color: var(--sig);
  background: var(--sig-soft);
}
.cd-key:active:not(:disabled) {
  transform: scale(0.86);
}
.cd-key:focus-visible {
  outline: 2px solid var(--sig);
  outline-offset: 2px;
}
.cd-key:disabled {
  opacity: 0.45;
  cursor: default;
}

/* ── the bus: a live cyan signal between the nodes ────────────────── */
.cd-bus {
  position: relative;
  display: grid;
  place-items: center;
}
.cd-wave {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.cd-wave path,
.cd-wave line {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.cd-wave__base {
  stroke: var(--sig);
  stroke-width: 1.6;
  opacity: 0.4;
  transition: opacity 0.3s ease;
}
/* a faint segment that perpetually drifts along the wire — realtime, made visible */
.cd-wave__live {
  stroke: var(--sig);
  stroke-width: 2;
  stroke-dasharray: 36 320;
  stroke-dashoffset: 356;
  opacity: 0;
  filter: drop-shadow(0 0 4px var(--sig-glow));
}
.cd-rig.ready .cd-bus:not(.severed) .cd-wave__live {
  opacity: 0.9;
  animation: cd-drift 2.6s linear infinite;
}
@keyframes cd-drift {
  to {
    stroke-dashoffset: 0;
  }
}
.cd-wave__flat {
  stroke: var(--dim);
  stroke-width: 1.5;
  stroke-dasharray: 3 6;
  opacity: 0;
  transition: opacity 0.3s ease;
}
.cd-bus.severed .cd-wave__base {
  opacity: 0;
}
.cd-bus.severed .cd-wave__flat {
  opacity: 0.5;
}

/* the event pulse: a bright blip that crosses the wire on a real cross-node send */
.cd-blip {
  position: absolute;
  top: 50%;
  left: 10%;
  width: 9px;
  height: 9px;
  margin-top: -4.5px;
  border-radius: 50%;
  background: #eafdff;
  box-shadow:
    0 0 0 3px var(--sig-soft),
    0 0 14px 3px var(--sig-glow);
  opacity: 0;
}
.cd-bus.flow-ab:not(.severed) .cd-blip {
  animation: cd-ab 0.62s cubic-bezier(0.4, 0, 0.2, 1);
}
.cd-bus.flow-ba:not(.severed) .cd-blip {
  animation: cd-ba 0.62s cubic-bezier(0.4, 0, 0.2, 1);
}
@keyframes cd-ab {
  0% {
    left: 6%;
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
  80% {
    opacity: 1;
  }
  100% {
    left: 94%;
    opacity: 0;
  }
}
@keyframes cd-ba {
  0% {
    left: 94%;
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
  80% {
    opacity: 1;
  }
  100% {
    left: 6%;
    opacity: 0;
  }
}

.cd-sever {
  position: relative;
  z-index: 1;
  padding: 4px 11px;
  font-family: var(--vp-font-family-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--bg);
  color: var(--dim);
  cursor: pointer;
  white-space: nowrap;
  transition:
    border-color 0.16s,
    color 0.16s,
    background-color 0.16s;
}
.cd-sever:hover:not(:disabled) {
  border-color: var(--sig);
  color: var(--sig);
}
.cd-sever:focus-visible {
  outline: 2px solid var(--sig);
  outline-offset: 2px;
}
.cd-sever:disabled {
  opacity: 0.5;
  cursor: default;
}
.cd-bus.severed .cd-sever {
  border-color: #d4634e;
  color: #ff8a72;
  background: rgba(212, 99, 78, 0.12);
}

/* ── status line ──────────────────────────────────────────────────── */
.cd-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 10px;
  max-width: 900px;
  margin: 22px auto 0;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  color: var(--vp-c-text-2);
}
.cd-status b {
  color: var(--vp-c-text-1);
  font-weight: 600;
}
.cd-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--vp-c-brand-1);
}
.cd-live.off {
  color: var(--vp-c-text-3, var(--vp-c-text-2));
}
.cd-live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 0 rgba(34, 211, 238, 0.5);
  animation: cd-blink 2s ease-in-out infinite;
}
@keyframes cd-blink {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(34, 211, 238, 0.5);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(34, 211, 238, 0);
  }
}
.cd-sep {
  opacity: 0.4;
}
.cd-reset {
  margin-left: 4px;
  padding: 4px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 20px;
  background: transparent;
  color: var(--vp-c-text-2);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
  transition:
    border-color 0.16s,
    color 0.16s;
}
.cd-reset:hover:not(:disabled) {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.cd-reset:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── responsive: stack the nodes, bus turns horizontal ────────────── */
@media (max-width: 720px) {
  .cd-rig {
    grid-template-columns: 1fr;
    max-width: 440px;
  }
  .cd-bus {
    height: 66px;
  }
  .cd-blip {
    top: auto;
    left: 50% !important;
    margin-top: 0;
    margin-left: -4.5px;
  }
  .cd-bus.flow-ab:not(.severed) .cd-blip {
    animation: cd-ab-v 0.62s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .cd-bus.flow-ba:not(.severed) .cd-blip {
    animation: cd-ba-v 0.62s cubic-bezier(0.4, 0, 0.2, 1);
  }
}
@keyframes cd-ab-v {
  0% {
    top: 8%;
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
  80% {
    opacity: 1;
  }
  100% {
    top: 92%;
    opacity: 0;
  }
}
@keyframes cd-ba-v {
  0% {
    top: 92%;
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
  80% {
    opacity: 1;
  }
  100% {
    top: 8%;
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cd-rig {
    transition: none;
  }
  .cd-key,
  .cd-reset,
  .cd-sever,
  .cd-lane,
  .cd-pip {
    transition: none;
  }
  .cd-spark {
    animation-duration: 0.01ms;
  }
  .cd-live-dot,
  .cd-wave__live {
    animation: none;
  }
  .cd-rig.ready .cd-bus:not(.severed) .cd-wave__live {
    opacity: 0.5;
    animation: none;
  }
  .cd-bus.flow-ab .cd-blip,
  .cd-bus.flow-ba .cd-blip {
    animation: none;
    opacity: 1;
  }
}
</style>
