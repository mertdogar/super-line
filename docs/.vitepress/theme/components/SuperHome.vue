<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'
import { withBase } from 'vitepress'
import ClusterDemo from './ClusterDemo.vue'

/* Hand-highlighted snippets. Code is the hero, so highlighting is tuned to the
   brand: strings carry the cyan accent, keywords a single soft-violet secondary,
   everything else stays light on a dark panel. All API calls are real super-line
   (verified against packages/server + the quickstart) — no invented surface. */
const heroCode = `<span class="c">// one contract — imported by both sides</span>
<span class="k">const</span> chat = <span class="f">defineContract</span>({
  shared: {
    clientToServer: {
      send: {
        input:  z.<span class="f">object</span>({ text: z.<span class="f">string</span>() }),
        output: z.<span class="f">object</span>({ id: z.<span class="f">string</span>() }),
      },
    },
    serverToClient: {
      message: {
        payload: z.<span class="f">object</span>({ text: z.<span class="f">string</span>() }),
      },
      online: {
        payload: z.<span class="f">object</span>({ count: z.<span class="f">number</span>() }),
        subscribe: <span class="k">true</span>,
      },
    },
  },
  roles: { user: {} },
})

<span class="c">// client — typed end to end, zero codegen</span>
<span class="k">await</span> client.<span class="f">send</span>({ text: <span class="s">'hi'</span> })   <span class="c">// req/res</span>
client.<span class="f">on</span>(<span class="s">'message'</span>, render)        <span class="c">// event</span>
client.<span class="f">subscribe</span>(<span class="s">'online'</span>, setOnline) <span class="c">// topic</span>`

const lawCode = `srv.<span class="f">implement</span>({
  shared: {
    <span class="c">// \`text\` is validated before your handler runs</span>
    send: <span class="k">async</span> ({ text }, ctx) => {
      srv.<span class="f">room</span>(<span class="s">'lobby'</span>).<span class="f">broadcast</span>(<span class="s">'message'</span>, { text })
      <span class="k">return</span> { id: crypto.<span class="f">randomUUID</span>() } <span class="c">// typed reply</span>
    },
  },
})`

/* ── transports: same code, any wire ─────────────────────────────────
   One client, one call — only the `transport:` line changes between wires.
   Each wire animates with its own texture (full-duplex line, marching SSE
   chunks, a peer-to-peer hop, an in-process blink). Calls are real
   super-line (verified against the transport packages + examples/transports). */
type Wire = {
  id: 'ws' | 'http' | 'libp2p' | 'loopback'
  label: string
  recv: string
  tag: string
  pkg: string
  code: string
}
const wires: Wire[] = [
  {
    id: 'ws',
    label: 'WebSocket',
    recv: 'websocket',
    tag: 'full-duplex · lowest latency · the default',
    pkg: '@super-line/transport-websocket',
    code: `<span class="f">webSocketClientTransport</span>({ url })`,
  },
  {
    id: 'http',
    label: 'HTTP',
    recv: 'sse',
    tag: 'SSE / long-poll · slips through proxies that block WS',
    pkg: '@super-line/transport-http',
    code: `<span class="f">httpClientTransport</span>({ url })`,
  },
  {
    id: 'libp2p',
    label: 'libp2p',
    recv: 'libp2p',
    tag: 'peer-to-peer · WebRTC / WebTransport · no signaling code',
    pkg: '@super-line/transport-libp2p',
    code: `<span class="f">libp2pClientTransport</span>({ node, multiaddr })`,
  },
  {
    id: 'loopback',
    label: 'Loopback',
    recv: 'loopback',
    tag: 'in-process · deterministic · your test suite',
    pkg: '@super-line/transport-loopback',
    code: `loopbackTransport.<span class="f">client</span>()`,
  },
]
const activeWire = ref<Wire['id']>('ws')
const arrived = ref(false)
const activeMeta = computed(() => wires.find((w) => w.id === activeWire.value) as Wire)
const wireCode = computed(
  () => `<span class="c">// one client — identical on every wire</span>
<span class="k">const</span> client = <span class="f">createSuperLineClient</span>(chat, {
  transport: <span class="wl">${activeMeta.value.code}</span>,<span class="c"> // ← the only line that changes</span>
  role: <span class="s">'user'</span>,
})
<span class="k">await</span> client.<span class="f">send</span>({ text: <span class="s">'hi'</span> }) <span class="c">// same call, every wire</span>`,
)

const prefersMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: no-preference)').matches
let wireCycle: ReturnType<typeof setInterval> | null = null
let arriveTimer: ReturnType<typeof setTimeout> | null = null

function selectWire(id: Wire['id'], byUser = false) {
  activeWire.value = id
  arrived.value = false
  if (arriveTimer) clearTimeout(arriveTimer)
  if (!prefersMotion()) {
    arrived.value = true
    return
  }
  arriveTimer = setTimeout(() => (arrived.value = true), 1050)
  // once the visitor drives the demo, stop the carousel and let them explore
  if (byUser && wireCycle) {
    clearInterval(wireCycle)
    wireCycle = null
  }
}
function cycleWire() {
  const i = wires.findIndex((w) => w.id === activeWire.value)
  selectWire(wires[(i + 1) % wires.length].id)
}

type Cell = { kind: 'yes' | 'no' | 'mid'; t?: string }
const cols = ['super-line', 'Socket.IO', 'tRPC', 'raw ws', 'dist. emitter']
const rows: { label: string; cells: Cell[] }[] = [
  { label: 'One typed contract (SSOT)', cells: [{ kind: 'yes' }, { kind: 'mid', t: 'types only' }, { kind: 'yes' }, { kind: 'no' }, { kind: 'no' }] },
  { label: 'Runtime validation', cells: [{ kind: 'yes' }, { kind: 'no' }, { kind: 'yes' }, { kind: 'no' }, { kind: 'no' }] },
  { label: 'Req/res — both directions', cells: [{ kind: 'yes' }, { kind: 'mid', t: 'ack cbs' }, { kind: 'mid', t: 'c→s only' }, { kind: 'no' }, { kind: 'no' }] },
  { label: 'Events & rooms', cells: [{ kind: 'yes' }, { kind: 'yes' }, { kind: 'no' }, { kind: 'no' }, { kind: 'mid', t: 'events' }] },
  { label: 'Topics (pub/sub)', cells: [{ kind: 'yes' }, { kind: 'mid', t: 'via rooms' }, { kind: 'mid', t: 'subs' }, { kind: 'no' }, { kind: 'yes' }] },
  { label: 'Pluggable transport (WS · HTTP · libp2p)', cells: [{ kind: 'yes' }, { kind: 'mid', t: 'WS + poll' }, { kind: 'mid', t: 'link-based' }, { kind: 'no' }, { kind: 'no' }] },
  { label: 'Cross-node fan-out', cells: [{ kind: 'yes' }, { kind: 'yes' }, { kind: 'no' }, { kind: 'no' }, { kind: 'yes' }] },
  { label: 'Per-role contracts', cells: [{ kind: 'yes' }, { kind: 'no' }, { kind: 'no' }, { kind: 'no' }, { kind: 'no' }] },
  { label: 'Presence / introspection', cells: [{ kind: 'yes', t: 'cluster' }, { kind: 'mid', t: 'rooms' }, { kind: 'no' }, { kind: 'no' }, { kind: 'no' }] },
  { label: 'Server-authoritative', cells: [{ kind: 'yes' }, { kind: 'mid' }, { kind: 'no' }, { kind: 'no' }, { kind: 'no' }] },
]

const root = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null
let fallback: ReturnType<typeof setTimeout> | null = null

onMounted(() => {
  // transport demo: time the "arrival" badge and auto-advance the wire carousel
  // (motion-gated — under reduced-motion it parks on a wire, fully readable).
  if (prefersMotion()) {
    arriveTimer = setTimeout(() => (arrived.value = true), 1050)
    wireCycle = setInterval(cycleWire, 3600)
  } else {
    arrived.value = true
  }

  const el = root.value
  if (!el) return
  // Only arm the scroll-reveal when motion is welcome; content is visible by
  // default (and for no-JS / reduced-motion), never gated on a class.
  if (!window.matchMedia('(prefers-reduced-motion: no-preference)').matches) return
  el.classList.add('armed')
  const targets = Array.from(el.querySelectorAll<HTMLElement>('.reveal'))
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in')
          io?.unobserve(e.target)
        }
      }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.1 },
  )
  targets.forEach((t) => io!.observe(t))
  // Safety net: if anything keeps a target from intersecting, reveal it anyway.
  fallback = setTimeout(() => targets.forEach((t) => t.classList.add('in')), 2200)
})

onBeforeUnmount(() => {
  io?.disconnect()
  if (fallback) clearTimeout(fallback)
  if (wireCycle) clearInterval(wireCycle)
  if (arriveTimer) clearTimeout(arriveTimer)
})
</script>

<template>
  <div ref="root" class="sl-home">
    <!-- ░░ HERO ░░ -->
    <header class="sl-hero">
      <svg class="sl-wave-bg" viewBox="0 0 1200 200" preserveAspectRatio="none" aria-hidden="true">
        <path
          d="M-20 120 H360 L420 120 L452 44 L500 168 L536 120 H760 L800 120 L832 70 L876 150 L908 120 H1240"
          fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round"
        />
      </svg>

      <div class="sl-shell sl-hero__grid">
        <div class="sl-hero__copy">
          <h1 class="sl-h1">
            The strictly typed, opinionated <span class="sl-h1__beat">data&nbsp;bus</span> for TypeScript.
          </h1>
          <p class="sl-lede">
            One contract for every pattern on the wire — requests, events, and
            subscriptions — with end-to-end types and zero codegen. Run the same
            code over <strong>WebSocket, HTTP, or libp2p/WebRTC</strong> — the
            transport is one line — on a single node or a cluster.
          </p>
          <div class="sl-cta">
            <a class="sl-btn sl-btn--primary" :href="withBase('/guide/getting-started')">Get started</a>
            <a class="sl-btn sl-btn--ghost" :href="withBase('/guide/the-contract')">The contract</a>
            <a class="sl-btn sl-btn--ghost" :href="withBase('/reference/')">API reference</a>
          </div>
          <p class="sl-install">
            <span class="sl-install__p">pnpm add</span>
            @super-line/core @super-line/server @super-line/client @super-line/transport-websocket
          </p>
        </div>

        <div class="sl-hero__code">
          <div class="sl-win">
            <div class="sl-win__bar">
              <span class="sl-win__dot" /><span class="sl-win__dot" /><span class="sl-win__dot" />
              <span class="sl-win__name">contract.ts + client.ts</span>
            </div>
            <pre class="sl-pre"><code v-html="heroCode" /></pre>
          </div>
        </div>
      </div>
    </header>

    <!-- ░░ THE ASSEMBLY TAX ░░ -->
    <section class="sl-sec">
      <div class="sl-shell">
        <div class="sl-sec__head reveal">
          <h2>Today, realtime is a glue job.</h2>
          <p>
            A connection from <code>ws</code>. An <code>EventEmitter</code> for
            local events. Redis pub/sub, hand-wired, when it has to cross
            processes. Correlation IDs and ack callbacks for request/response.
            Four moving parts, none of them typed across the wire — re-assembled
            on every project.
          </p>
        </div>
        <div class="sl-swap reveal">
          <ul class="sl-stack" aria-label="What you assemble by hand today">
            <li><code>ws</code><span>raw transport</span></li>
            <li><code>EventEmitter</code><span>local events</span></li>
            <li><code>redis</code><span>pub/sub fan-out</span></li>
            <li><code>ack glue</code><span>req/res by hand</span></li>
          </ul>
          <div class="sl-swap__arrow" aria-hidden="true">
            <svg viewBox="0 0 80 24" fill="none"><path d="M2 12h70m0 0-10-7m10 7-10 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <div class="sl-one">
            <span class="sl-one__mark">super-line</span>
            <span>one contract · one connection · strictly typed</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ░░ THE CONTRACT IS THE LAW ░░ -->
    <section class="sl-sec sl-sec--alt">
      <div class="sl-shell sl-split">
        <div class="sl-split__copy reveal">
          <h2>Rename a field. The other side stops compiling.</h2>
          <p>
            The contract is one object both ends import, so an event name or
            payload can't drift between client and server — change it in one
            place and TypeScript flags every call that no longer fits.
          </p>
          <p>
            And types aren't trust. Every inbound message is validated against
            the same schema at runtime, so even an untyped peer can't slip a bad
            payload past the server.
          </p>
        </div>
        <div class="sl-split__code reveal">
          <div class="sl-win">
            <div class="sl-win__bar">
              <span class="sl-win__dot" /><span class="sl-win__dot" /><span class="sl-win__dot" />
              <span class="sl-win__name">server.ts</span>
            </div>
            <pre class="sl-pre"><code v-html="lawCode" /></pre>
          </div>
        </div>
      </div>
    </section>

    <!-- ░░ SAME APP, ANY WIRE (TRANSPORTS) ░░ -->
    <section class="sl-sec">
      <div class="sl-shell">
        <div class="sl-sec__head reveal">
          <p class="sl-kicker"><span class="sl-new">New</span> Pluggable transports</p>
          <h2>Same app. Any wire.</h2>
          <p>
            super-line splits <strong>what</strong> travels — your typed
            contract — from <strong>how</strong> it travels. The same server,
            the same client, the same handlers run over a WebSocket, an HTTP/SSE
            stream, or a libp2p/WebRTC peer connection.
            <span class="sl-hl">The transport is one line; everything above it is
            identical.</span>
          </p>
        </div>

        <div class="sl-wireboard reveal">
          <div class="sl-wireboard__bar" role="tablist" aria-label="Pick a transport">
            <button
              v-for="w in wires"
              :key="w.id"
              class="sl-wiretab"
              :class="{ 'is-on': activeWire === w.id }"
              type="button"
              role="tab"
              :aria-selected="activeWire === w.id"
              @click="selectWire(w.id, true)"
            >
              {{ w.label }}
            </button>
            <code class="sl-wireboard__pkg">{{ activeMeta.pkg }}</code>
          </div>

          <div
            class="sl-stage"
            role="img"
            :aria-label="`Signal travelling from client to server over ${activeMeta.label} — ${activeMeta.tag}`"
          >
            <svg class="sl-lane" viewBox="0 0 760 168" :data-wire="activeWire" aria-hidden="true">
              <defs>
                <filter id="slGlow" x="-25%" y="-60%" width="150%" height="220%">
                  <feGaussianBlur stdDeviation="3" result="b" />
                  <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>

              <!-- endpoints -->
              <g class="sl-lnode">
                <rect x="18" y="58" width="108" height="52" rx="11" />
                <circle class="sl-lnode__led" cx="40" cy="84" r="3.5" />
                <text x="80" y="88" text-anchor="middle">client</text>
              </g>
              <g class="sl-lnode">
                <rect x="634" y="58" width="108" height="52" rx="11" />
                <circle class="sl-lnode__led" cx="716" cy="84" r="3.5" />
                <text x="680" y="88" text-anchor="middle">server</text>
              </g>

              <!-- WebSocket — a continuous full-duplex waveform -->
              <g v-show="activeWire === 'ws'" class="sl-w sl-w--ws">
                <path
                  class="sl-w__base"
                  d="M126 84 H232 l14 0 l12 -34 l18 64 l12 -30 H378 l14 0 l12 -30 l18 56 l12 -26 H634"
                />
                <path
                  class="sl-w__sweep"
                  pathLength="100"
                  d="M126 84 H232 l14 0 l12 -34 l18 64 l12 -30 H378 l14 0 l12 -30 l18 56 l12 -26 H634"
                />
                <path
                  class="sl-w__return"
                  pathLength="100"
                  d="M126 84 H232 l14 0 l12 -34 l18 64 l12 -30 H378 l14 0 l12 -30 l18 56 l12 -26 H634"
                />
              </g>

              <!-- HTTP — discrete SSE / long-poll chunks marching server-ward -->
              <g v-show="activeWire === 'http'" class="sl-w sl-w--http">
                <path class="sl-w__base" d="M126 84 H634" />
                <path class="sl-w__march" pathLength="100" d="M126 84 H634" />
              </g>

              <!-- libp2p — a peer-to-peer hop through the mesh -->
              <g v-show="activeWire === 'libp2p'" class="sl-w sl-w--libp2p">
                <path class="sl-w__base" d="M126 84 C 214 30, 300 30, 380 84 S 556 138, 634 84" />
                <path
                  class="sl-w__sweep"
                  pathLength="100"
                  d="M126 84 C 214 30, 300 30, 380 84 S 556 138, 634 84"
                />
                <circle class="sl-peer" style="--d: 0.45s" cx="250" cy="45" r="5" />
                <circle class="sl-peer" style="--d: 1.25s" cx="500" cy="123" r="5" />
              </g>

              <!-- Loopback — same process, no wire at all -->
              <g v-show="activeWire === 'loopback'" class="sl-w sl-w--loop">
                <path class="sl-w__base sl-w__base--dot" d="M126 84 H634" />
                <g class="sl-loop">
                  <rect x="324" y="68" width="112" height="32" rx="16" />
                  <text x="380" y="88" text-anchor="middle">in-process</text>
                </g>
              </g>
            </svg>

            <p class="sl-stage__cap">
              <span class="sl-stage__wire">{{ activeMeta.label }}</span>{{ activeMeta.tag }}
            </p>
          </div>

          <div class="sl-wireboard__code">
            <pre class="sl-pre"><code :key="activeWire" v-html="wireCode" /></pre>
            <div class="sl-wirebadge" :class="{ 'is-on': arrived }">
              <span class="sl-wirebadge__tag">client → {{ activeMeta.label.toLowerCase() }}</span>
              <span class="sl-wirebadge__txt">send({ text: 'hi' })</span>
              <span class="sl-wirebadge__res">
                <template v-if="arrived">✓ received via "{{ activeMeta.recv }}"</template>
                <template v-else>… on the wire</template>
              </span>
            </div>
          </div>
        </div>

        <p class="sl-real sl-wire-real">
          Real: <code>examples/transports</code> — one server mounts WebSocket,
          HTTP and libp2p <em>at once</em>; three clients call the same
          <code>echo</code>, each over a different wire.
        </p>

        <div class="sl-axes reveal" aria-label="super-line has two independent pluggable axes: transport and adapter">
          <div class="sl-axis">
            <span class="sl-axis__glyph" aria-hidden="true">↕</span>
            <div class="sl-axis__body">
              <p class="sl-axis__h">
                <strong>Transport</strong> — the client&nbsp;↔&nbsp;server wire
                <span class="sl-axis__here">this section</span>
              </p>
              <p class="sl-axis__chips">
                <code>WebSocket</code><code>HTTP</code><code>libp2p</code><code>loopback</code>
              </p>
            </div>
          </div>
          <div class="sl-axis">
            <span class="sl-axis__glyph" aria-hidden="true">↔</span>
            <div class="sl-axis__body">
              <p class="sl-axis__h">
                <strong>Adapter</strong> — the server&nbsp;↔&nbsp;server fan-out
                <span class="sl-axis__here sl-axis__here--next">next ↓</span>
              </p>
              <p class="sl-axis__chips">
                <code>Redis</code><code>libp2p</code><code>RabbitMQ</code><code>ZeroMQ</code>
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ░░ IT WORKS ON ONE NODE — THEN YOU ADD A SECOND ░░ -->
    <section class="sl-sec sl-sec--alt">
      <div class="sl-shell reveal">
        <ClusterDemo />
      </div>
    </section>

    <!-- ░░ CONTROL CENTER ░░ -->
    <section class="sl-sec">
      <div class="sl-shell sl-split">
        <div class="sl-split__copy reveal">
          <h2>See the whole network.</h2>
          <p>
            Flip on <code>inspector: true</code> and point Control Center at any
            node. It draws your live topology, every connection with its
            <code>ctx</code>, the running contract, and a streaming event feed —
            cluster-wide, with no instrumentation to add.
          </p>
          <p class="sl-real"><code>npx @super-line/control-center</code></p>
        </div>
        <div class="sl-split__code reveal">
          <div class="sl-win">
            <div class="sl-win__bar">
              <span class="sl-win__dot" /><span class="sl-win__dot" /><span class="sl-win__dot" />
              <span class="sl-win__name">super-line · Control Center</span>
            </div>
            <div class="sl-cc__body">
              <nav class="sl-cc__rail" aria-hidden="true">
                <span class="is-active">Topology</span>
                <span>Connections</span>
                <span>Contract</span>
                <span>Live feed</span>
              </nav>
              <div class="sl-cc__canvas" role="img" aria-label="Control Center topology: two nodes connected through a central Adapter · bus, with user connections on each node">
                <div class="sl-cc__tier">
                  <span class="sl-cc-chip"><i /> user · user1</span>
                  <span class="sl-cc-node">node-2<small>2 conns</small></span>
                  <span class="sl-cc-chip"><i /> user · dogar1</span>
                </div>
                <span class="sl-cc-adapter">Adapter · bus</span>
                <div class="sl-cc__tier">
                  <span class="sl-cc-node">node-1<small>1 conn</small></span>
                  <span class="sl-cc-chip"><i /> user · personX</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ░░ SERVER-AUTHORITATIVE ░░ -->
    <section class="sl-sec sl-sec--alt">
      <div class="sl-shell">
        <div class="sl-sec__head reveal">
          <h2>Opinionated, on purpose: the server is in charge.</h2>
          <p>super-line takes three positions and holds them — so you don't re-litigate them per feature.</p>
        </div>
        <ol class="sl-tenets reveal">
          <li>
            <h3>The contract is the source of truth</h3>
            <p>One object, split by direction and scoped by role. Types flow to both ends; a cross-role call gets <code>NOT_FOUND</code>.</p>
          </li>
          <li>
            <h3>Nothing on the wire is trusted</h3>
            <p>Every inbound message is validated against its schema before a handler ever sees it. Always on, not opt-in.</p>
          </li>
          <li>
            <h3>The server owns rooms &amp; topics</h3>
            <p>Clients don't self-join or self-subscribe. Membership and authorization live on the server, where they belong.</p>
          </li>
        </ol>
      </div>
    </section>

    <!-- ░░ COMPARISON ░░ -->
    <section class="sl-sec">
      <div class="sl-shell">
        <div class="sl-sec__head reveal">
          <h2>One library where you'd otherwise reach for several.</h2>
          <p>It's a typed distributed event emitter — <em>and</em> req/res, rooms, presence, and a server that's in charge.</p>
        </div>
        <div class="sl-tablewrap reveal">
          <table class="sl-table">
            <caption class="sl-vh">Capability comparison of super-line against Socket.IO, tRPC, raw ws, and distributed event-emitter libraries</caption>
            <thead>
              <tr>
                <th scope="col" class="sl-table__rowhead">Capability</th>
                <th v-for="(c, i) in cols" :key="c" scope="col" :class="{ 'is-us': i === 0 }">{{ c }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.label">
                <th scope="row" class="sl-table__rowhead">{{ row.label }}</th>
                <td v-for="(cell, i) in row.cells" :key="i" :class="['sl-cell', `is-${cell.kind}`, { 'is-us': i === 0 }]">
                  <span v-if="cell.kind === 'yes'" class="sl-mark sl-mark--yes" aria-hidden="true">✓</span>
                  <span v-else-if="cell.kind === 'no'" class="sl-mark sl-mark--no" aria-hidden="true">–</span>
                  <span v-else class="sl-mark sl-mark--mid" aria-hidden="true">~</span>
                  <span v-if="cell.t" class="sl-cell__t">{{ cell.t }}</span>
                  <span class="sl-vh">{{ cell.kind === 'yes' ? 'yes' : cell.kind === 'no' ? 'no' : 'partial' }}{{ cell.t ? ' — ' + cell.t : '' }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ░░ REASSURANCE / CTA ░░ -->
    <section class="sl-sec sl-sec--foot">
      <div class="sl-shell sl-foot">
        <div class="reveal">
          <h2>One bus. Every pattern. Any wire.</h2>
          <p class="sl-foot__lead">
            Requests, events, and subscriptions over one typed connection, zero
            codegen — on WebSocket, HTTP, or libp2p, with reconnection, presence,
            and a cluster event bus built in. Swap the wire in one line; add an
            adapter only when you outgrow a single node.
          </p>
          <div class="sl-term sl-term--install" aria-label="Install command">
            <div class="sl-term__line">
              <span class="sl-term__tag is-cmd">npm</span>
              <span class="sl-term__txt">pnpm add @super-line/core @super-line/server @super-line/client zod</span>
            </div>
          </div>
          <div class="sl-cta">
            <a class="sl-btn sl-btn--primary" :href="withBase('/guide/getting-started')">Get started</a>
            <a class="sl-btn sl-btn--ghost" href="https://github.com/mertdogar/super-line" target="_blank" rel="noreferrer">GitHub ↗</a>
          </div>
          <p class="sl-status">
            Pre-1.0 — role-scoped contracts, req/res, events, rooms, topics, the
            cluster event bus, presence, and reconnect are implemented and tested
            — over pluggable transports (WebSocket, HTTP, libp2p, loopback) and
            pluggable adapters (in-memory, Redis, libp2p, RabbitMQ, ZeroMQ).
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ── shell & rhythm ─────────────────────────────────────────────── */
.sl-home {
  --shell: 1120px;
  --pad: clamp(1.25rem, 5vw, 2.5rem);
  color: var(--sl-text);
  overflow: clip;
}
.sl-shell {
  max-width: var(--shell);
  margin-inline: auto;
  padding-inline: var(--pad);
}
.sl-sec {
  padding-block: clamp(3.5rem, 9vw, 7rem);
}
.sl-sec--alt {
  background: var(--vp-c-bg-soft);
  border-block: 1px solid var(--vp-c-divider);
}
.sl-sec__head {
  max-width: 46rem;
}
.sl-sec__head h2,
.sl-split__copy h2,
.sl-foot h2 {
  font-size: clamp(1.7rem, 3.6vw, 2.6rem);
  line-height: 1.1;
  letter-spacing: -0.025em;
  font-weight: 800;
  text-wrap: balance;
  margin: 0 0 0.85rem;
}
.sl-sec__head p,
.sl-split__copy p,
.sl-foot__lead {
  font-size: clamp(1rem, 1.7vw, 1.12rem);
  line-height: 1.65;
  color: var(--sl-text-2);
  max-width: 65ch;
  text-wrap: pretty;
  margin: 0 0 0.9rem;
}
.sl-home code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.86em;
  padding: 0.12em 0.38em;
  border-radius: 5px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  color: var(--sl-cyan-strong);
}
.sl-sec--alt .sl-home code,
.sl-sec--alt code {
  background: var(--vp-c-bg);
}

/* ── hero ───────────────────────────────────────────────────────── */
.sl-hero {
  position: relative;
  padding-block: clamp(3rem, 8vw, 6rem) clamp(3.5rem, 9vw, 7rem);
  isolation: isolate;
}
.sl-wave-bg {
  position: absolute;
  inset-inline: 0;
  top: clamp(2rem, 14vw, 9rem);
  width: 100%;
  height: clamp(180px, 26vw, 320px);
  color: var(--sl-cyan);
  opacity: 0.14;
  z-index: -1;
  pointer-events: none;
}
.sl-hero__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.08fr);
  gap: clamp(2rem, 5vw, 4rem);
  align-items: start;
}
.sl-h1 {
  font-size: clamp(2.1rem, 5.4vw, 3.6rem);
  line-height: 1.04;
  letter-spacing: -0.035em;
  font-weight: 800;
  margin: 0 0 1.35rem;
  text-wrap: balance;
}
.sl-h1__beat {
  position: relative;
  display: inline-block;
  white-space: nowrap;
  padding-bottom: 0.04em;
}
.sl-h1__beat::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 100%;
  height: 3px;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--sl-cyan), transparent);
}
.sl-lede {
  font-size: clamp(1.02rem, 1.7vw, 1.18rem);
  line-height: 1.6;
  color: var(--sl-text-2);
  max-width: 48ch;
  margin: 0 0 1.6rem;
  text-wrap: pretty;
}
.sl-cta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.7rem;
  margin-bottom: 1.5rem;
}
.sl-btn {
  display: inline-flex;
  align-items: center;
  font-weight: 600;
  font-size: 0.95rem;
  padding: 0.62rem 1.15rem;
  border-radius: 9px;
  transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1), background-color 0.18s, border-color 0.18s;
  border: 1px solid transparent;
}
.sl-btn--primary {
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
}
.sl-btn--primary:hover {
  background: var(--vp-button-brand-hover-bg);
  transform: translateY(-1px);
}
.sl-btn--ghost {
  border-color: var(--vp-c-divider);
  color: var(--sl-text);
}
.sl-btn--ghost:hover {
  border-color: var(--sl-cyan);
  color: var(--sl-cyan-strong);
  transform: translateY(-1px);
}
.sl-install {
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  color: var(--sl-text-2);
  margin: 0;
  overflow-wrap: anywhere;
}
.sl-install__p { color: var(--sl-cyan-strong); }
.sl-install__p::before { content: '$ '; opacity: 0.5; }

/* ── code window ────────────────────────────────────────────────── */
.sl-win {
  border-radius: 14px;
  background: var(--sl-code-bg);
  border: 1px solid var(--sl-code-border);
  box-shadow: 0 24px 60px -28px rgba(2, 12, 20, 0.7), 0 2px 10px -4px rgba(2, 12, 20, 0.5);
  overflow: hidden;
}
.sl-win__bar {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.7rem 0.95rem;
  background: var(--sl-code-bg-2);
  border-bottom: 1px solid var(--sl-code-border);
}
.sl-win__dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #2c3744;
}
.sl-win__dot:first-child { background: #3a4654; }
.sl-win__name {
  margin-left: 0.5rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  color: var(--sl-code-dim);
}
.sl-pre {
  margin: 0;
  padding: 1.15rem 1.25rem;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: clamp(0.72rem, 0.88vw, 0.8rem);
  line-height: 1.7;
  color: var(--sl-code-text);
  tab-size: 2;
}
/* keep the page's inline-code styling out of the dark code panel */
.sl-pre code {
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  font-size: inherit;
  border-radius: 0;
}
.sl-pre :deep(.c) { color: var(--sl-code-dim); font-style: italic; }
.sl-pre :deep(.k) { color: var(--sl-code-key); }
.sl-pre :deep(.s) { color: var(--sl-code-str); }
.sl-pre :deep(.f) { color: var(--sl-code-fn); }
.sl-pre :deep(.n) { color: var(--sl-code-num); }

/* ── assembly tax ───────────────────────────────────────────────── */
.sl-swap {
  margin-top: clamp(2rem, 4vw, 3rem);
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: clamp(1rem, 3vw, 2.5rem);
  align-items: center;
}
.sl-stack {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.55rem;
}
.sl-stack li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 0.95rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg);
}
.sl-stack li code {
  background: none;
  border: none;
  padding: 0;
  color: var(--sl-text);
  font-weight: 600;
}
.sl-stack li span {
  font-size: 0.82rem;
  color: var(--sl-text-2);
}
.sl-swap__arrow {
  color: var(--sl-cyan);
}
.sl-swap__arrow svg { width: 70px; height: 22px; }
.sl-one {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.45rem;
  padding: 1.4rem 1.3rem;
  border-radius: 12px;
  background: linear-gradient(160deg, color-mix(in oklab, var(--sl-cyan) 16%, var(--vp-c-bg)), var(--vp-c-bg));
  border: 1px solid color-mix(in oklab, var(--sl-cyan) 35%, var(--vp-c-divider));
}
.sl-one__mark {
  font-weight: 800;
  font-size: 1.25rem;
  letter-spacing: -0.02em;
  color: var(--sl-cyan-strong);
}
.sl-one span:last-child {
  font-size: 0.9rem;
  color: var(--sl-text-2);
}

/* ── split sections ─────────────────────────────────────────────── */
.sl-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  gap: clamp(2rem, 5vw, 4rem);
  align-items: center;
}
/* reversed layout: copy moves right, but the code keeps the wider column */
.sl-split--rev { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); }
.sl-split--rev .sl-split__copy { order: 2; }
.sl-split__copy,
.sl-split__code { min-width: 0; }
.sl-fix { color: var(--sl-text); }
.sl-fix code { color: var(--sl-cyan-strong); }
.sl-real {
  font-size: 0.88rem !important;
  color: var(--sl-text-2);
}

/* ── terminal ───────────────────────────────────────────────────── */
.sl-term {
  margin-top: 1rem;
  border-radius: 12px;
  background: var(--sl-code-bg);
  border: 1px solid var(--sl-code-border);
  padding: 0.85rem 1rem;
  font-family: var(--vp-font-family-mono);
  font-size: clamp(0.68rem, 0.9vw, 0.78rem);
  line-height: 1.5;
  overflow-x: auto;
}
.sl-term__line {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  white-space: nowrap;
  padding-block: 0.12rem;
}
.sl-term__tag {
  flex: none;
  color: var(--sl-code-dim);
  border: 1px solid var(--sl-code-border);
  border-radius: 5px;
  padding: 0.05rem 0.4rem;
  font-size: 0.92em;
}
.sl-term__tag.is-client { color: var(--sl-code-str); border-color: color-mix(in oklab, var(--sl-cyan) 40%, transparent); }
.sl-term__tag.is-cmd { color: var(--sl-code-str); }
.sl-term__txt { color: var(--sl-code-text); overflow: hidden; text-overflow: ellipsis; }
.sl-term__tally { margin-left: auto; color: var(--sl-code-dim); flex: none; }
.sl-term__tally.is-self { color: var(--sl-code-str); }
.sl-term--install .sl-term__txt { white-space: normal; word-break: break-all; }

/* ── control center mock ────────────────────────────────────────── */
.sl-cc__body {
  display: grid;
  grid-template-columns: 116px 1fr;
  min-height: 300px;
}
.sl-cc__rail {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.85rem 0.6rem;
  border-right: 1px solid var(--sl-code-border);
  font-size: 0.74rem;
  color: var(--sl-code-dim);
}
.sl-cc__rail span { padding: 0.35rem 0.5rem; border-radius: 7px; }
.sl-cc__rail .is-active {
  background: color-mix(in oklab, var(--sl-cyan) 16%, transparent);
  color: var(--sl-code-str);
}
.sl-cc__canvas {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.5rem 1rem;
  background:
    radial-gradient(circle at 50% 50%, color-mix(in oklab, var(--sl-cyan) 6%, transparent), transparent 68%),
    var(--sl-code-bg);
}
.sl-cc__canvas::before {
  content: '';
  position: absolute;
  top: 2.4rem;
  bottom: 2.4rem;
  left: 50%;
  border-left: 2px dashed color-mix(in oklab, var(--sl-cyan) 70%, transparent);
}
.sl-cc__tier {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 0.5rem;
}
.sl-cc-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.25;
  padding: 0.45rem 0.85rem;
  border-radius: 9px;
  background: var(--sl-code-bg-2);
  border: 1px solid var(--sl-code-border);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--sl-code-text);
}
.sl-cc-node small { font-weight: 400; font-size: 0.65rem; color: var(--sl-code-dim); }
.sl-cc-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.32rem 0.6rem;
  border-radius: 7px;
  background: var(--sl-code-bg-2);
  border: 1px solid color-mix(in oklab, #e3b341 38%, var(--sl-code-border));
  font-size: 0.68rem;
  color: var(--sl-code-text);
  white-space: nowrap;
}
.sl-cc-chip i { width: 7px; height: 7px; border-radius: 50%; background: #e3b341; flex: none; }
.sl-cc-adapter {
  position: relative;
  z-index: 1;
  padding: 0.42rem 0.9rem;
  border-radius: 999px;
  background: var(--sl-code-bg);
  border: 1px solid var(--sl-cyan);
  font-size: 0.74rem;
  font-weight: 600;
  color: var(--sl-code-str);
}

/* ── transports: same app, any wire ─────────────────────────────── */
.sl-kicker {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  margin: 0 0 0.7rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--sl-text-2);
}
.sl-new {
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--sl-on-cyan);
  background: var(--sl-cyan-bright);
  padding: 0.14rem 0.45rem;
  border-radius: 999px;
}
.sl-hl {
  color: var(--sl-cyan-strong);
  font-weight: 600;
}

.sl-wireboard {
  margin-top: clamp(1.6rem, 3.5vw, 2.4rem);
  border-radius: 16px;
  background: var(--sl-code-bg);
  border: 1px solid var(--sl-code-border);
  box-shadow: 0 24px 60px -28px rgba(2, 12, 20, 0.7), 0 2px 10px -4px rgba(2, 12, 20, 0.5);
  overflow: hidden;
}
.sl-wireboard__bar {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
  padding: 0.6rem 0.7rem;
  background: var(--sl-code-bg-2);
  border-bottom: 1px solid var(--sl-code-border);
}
.sl-wiretab {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--sl-code-dim);
  font: 600 0.8rem/1 var(--vp-font-family-mono);
  padding: 0.4rem 0.72rem;
  border-radius: 8px;
  cursor: pointer;
  transition: color 0.18s, background-color 0.18s, border-color 0.18s;
}
.sl-wiretab:hover {
  color: var(--sl-code-text);
}
.sl-wiretab.is-on {
  color: var(--sl-on-cyan);
  background: var(--sl-cyan-bright);
  border-color: var(--sl-cyan-bright);
}
.sl-wiretab:focus-visible {
  outline: 2px solid var(--sl-cyan-bright);
  outline-offset: 2px;
}
.sl-wireboard__pkg {
  margin-left: auto;
  font: 500 0.72rem/1 var(--vp-font-family-mono);
  color: var(--sl-code-dim);
  background: none;
  border: 0;
  padding: 0;
}

.sl-stage {
  padding: clamp(0.4rem, 2vw, 0.9rem) clamp(0.5rem, 2vw, 1.1rem) 0.85rem;
  background:
    radial-gradient(120% 82% at 50% 38%, color-mix(in oklab, var(--sl-cyan) 8%, transparent), transparent 70%),
    var(--sl-code-bg);
}
.sl-lane {
  width: 100%;
  height: auto;
  display: block;
  max-height: 208px;
}
.sl-lnode rect {
  fill: var(--sl-code-bg-2);
  stroke: var(--sl-code-border);
  stroke-width: 1.5;
}
.sl-lnode text {
  fill: var(--sl-code-text);
  font: 600 15px var(--vp-font-family-mono);
}
.sl-lnode__led {
  fill: var(--sl-cyan-bright);
}
.sl-w__base {
  fill: none;
  stroke: color-mix(in oklab, var(--sl-cyan) 34%, transparent);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sl-w--http .sl-w__base {
  stroke-dasharray: 4 8;
}
.sl-w__base--dot {
  stroke-dasharray: 2 9;
}
.sl-w__sweep,
.sl-w__return,
.sl-w__march {
  fill: none;
  stroke: var(--sl-cyan-bright);
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: url(#slGlow);
}
.sl-w__sweep {
  stroke-dasharray: 9 91;
  stroke-dashoffset: 55;
}
.sl-w__return {
  stroke-dasharray: 5 95;
  stroke-width: 2;
  opacity: 0.5;
}
.sl-w__march {
  stroke-dasharray: 7 9;
}
.sl-peer {
  fill: var(--sl-cyan-bright);
  opacity: 0.5;
  transform-box: fill-box;
  transform-origin: center;
}
.sl-loop rect {
  fill: color-mix(in oklab, var(--sl-cyan) 16%, var(--sl-code-bg-2));
  stroke: var(--sl-cyan);
  stroke-width: 1.5;
}
.sl-loop text {
  fill: var(--sl-code-str);
  font: 600 13px var(--vp-font-family-mono);
}
.sl-stage__cap {
  margin: 0.25rem 0 0;
  text-align: center;
  font: 500 clamp(0.72rem, 0.95vw, 0.82rem) / 1.4 var(--vp-font-family-mono);
  color: var(--sl-code-dim);
}
.sl-stage__wire {
  color: var(--sl-code-str);
  font-weight: 600;
  margin-right: 0.5rem;
}

.sl-wireboard__code {
  border-top: 1px solid var(--sl-code-border);
}
.sl-wireboard__code .sl-pre {
  padding-bottom: 0.4rem;
}
.sl-pre :deep(.wl) {
  border-radius: 4px;
  padding: 0.05em 0.32em;
  background: color-mix(in oklab, var(--sl-cyan) 16%, transparent);
}
.sl-wirebadge {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
  margin: 0;
  padding: 0.7rem 1rem;
  border-top: 1px solid var(--sl-code-border);
  background: var(--sl-code-bg-2);
  font: 500 clamp(0.7rem, 0.9vw, 0.78rem) / 1.4 var(--vp-font-family-mono);
}
.sl-wirebadge__tag {
  color: var(--sl-code-str);
  border: 1px solid color-mix(in oklab, var(--sl-cyan) 40%, transparent);
  border-radius: 5px;
  padding: 0.05rem 0.4rem;
}
.sl-wirebadge__txt {
  color: var(--sl-code-text);
}
.sl-wirebadge__res {
  margin-left: auto;
  color: var(--sl-code-dim);
  transition: color 0.25s;
}
.sl-wirebadge.is-on .sl-wirebadge__res {
  color: var(--sl-code-str);
}
.sl-wire-real {
  margin-top: 1.05rem;
}

.sl-axes {
  margin-top: clamp(1.5rem, 3.5vw, 2.2rem);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr));
  gap: clamp(0.75rem, 2vw, 1.1rem);
}
.sl-axis {
  display: flex;
  align-items: flex-start;
  gap: 0.85rem;
  padding: 1rem 1.1rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.sl-axis__glyph {
  flex: none;
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: 8px;
  background: color-mix(in oklab, var(--sl-cyan) 14%, transparent);
  color: var(--sl-cyan-strong);
  font-size: 1.15rem;
  font-weight: 700;
}
.sl-axis__h {
  margin: 0 0 0.55rem;
  font-size: 0.95rem;
  line-height: 1.45;
  color: var(--sl-text);
}
.sl-axis__h strong {
  color: var(--sl-cyan-strong);
}
.sl-axis__here {
  display: inline-block;
  margin-left: 0.4rem;
  font-size: 0.7rem;
  font-weight: 600;
  white-space: nowrap;
  color: var(--sl-text-2);
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  padding: 0.04rem 0.5rem;
}
.sl-axis__here--next {
  color: var(--sl-cyan-strong);
  border-color: color-mix(in oklab, var(--sl-cyan) 40%, var(--vp-c-divider));
}
.sl-axis__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin: 0;
}
.sl-axis__chips code {
  font-size: 0.74rem;
  background: var(--vp-c-bg);
}

@keyframes sl-sweep {
  from { stroke-dashoffset: 100; }
  to { stroke-dashoffset: 0; }
}
@keyframes sl-return {
  from { stroke-dashoffset: 0; }
  to { stroke-dashoffset: 100; }
}
@keyframes sl-chunk {
  from { stroke-dashoffset: 0; }
  to { stroke-dashoffset: -16; }
}
@keyframes sl-peer {
  0%, 100% { opacity: 0.35; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.25); }
}
@keyframes sl-blink {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
@keyframes sl-wlin {
  from { background: color-mix(in oklab, var(--sl-cyan) 40%, transparent); }
  to { background: color-mix(in oklab, var(--sl-cyan) 16%, transparent); }
}

@media (prefers-reduced-motion: no-preference) {
  .sl-w__sweep { animation: sl-sweep 1.6s linear infinite; }
  .sl-w--libp2p .sl-w__sweep { animation-duration: 2.2s; }
  .sl-w__return { animation: sl-return 2.6s linear infinite; }
  .sl-w__march { animation: sl-chunk 0.85s linear infinite; }
  .sl-peer { animation: sl-peer 1.7s ease-in-out infinite; animation-delay: var(--d, 0s); }
  .sl-loop { animation: sl-blink 1.3s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
  .sl-wireboard__code .sl-pre :deep(.wl) { animation: sl-wlin 0.5s ease both; }
}

/* ── tenets ─────────────────────────────────────────────────────── */
.sl-tenets {
  list-style: none;
  counter-reset: t;
  margin: clamp(1.8rem, 4vw, 2.6rem) 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
  gap: clamp(1rem, 2.5vw, 1.75rem);
}
.sl-tenets li {
  counter-increment: t;
  position: relative;
  padding-top: 2.3rem;
}
.sl-tenets li::before {
  content: counter(t, decimal-leading-zero);
  position: absolute;
  top: 0;
  left: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--sl-cyan-strong);
}
.sl-tenets li::after {
  content: '';
  position: absolute;
  top: 0.55rem;
  left: 2.4rem;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, var(--sl-cyan), transparent);
  opacity: 0.4;
}
.sl-tenets h3 {
  font-size: 1.08rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 0.4rem;
}
.sl-tenets p {
  font-size: 0.95rem;
  line-height: 1.6;
  color: var(--sl-text-2);
  margin: 0;
}

/* ── comparison table ───────────────────────────────────────────── */
.sl-tablewrap {
  margin-top: clamp(1.5rem, 3vw, 2.25rem);
  overflow-x: auto;
  /* paint containment stops the wide table's scrollable overflow from
     leaking out to scroll the whole page on narrow viewports */
  contain: paint;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
}
.sl-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
  min-width: 640px;
}
.sl-table th,
.sl-table td {
  padding: 0.7rem 0.6rem;
  text-align: center;
  border-bottom: 1px solid var(--vp-c-divider);
}
.sl-table thead th {
  font-weight: 600;
  font-size: 0.82rem;
  color: var(--sl-text-2);
  white-space: nowrap;
  background: var(--vp-c-bg-soft);
}
.sl-table__rowhead {
  text-align: left !important;
  font-weight: 500;
  color: var(--sl-text);
  white-space: nowrap;
  position: sticky;
  left: 0;
  background: var(--vp-c-bg);
}
.sl-sec--alt .sl-table__rowhead { background: var(--vp-c-bg-soft); }
.sl-table tbody tr:last-child th,
.sl-table tbody tr:last-child td { border-bottom: none; }
.sl-table .is-us {
  background: color-mix(in oklab, var(--sl-cyan) 9%, var(--vp-c-bg));
}
.sl-table thead .is-us {
  color: var(--sl-cyan-strong);
  font-weight: 700;
}
.sl-cell { vertical-align: middle; }
.sl-mark {
  font-size: 1.05rem;
  font-weight: 700;
  line-height: 1;
}
.sl-mark--yes { color: var(--sl-cyan-strong); }
.sl-mark--no { color: var(--vp-c-text-3); }
.sl-mark--mid { color: var(--vp-c-text-2); }
.sl-cell__t {
  display: block;
  font-size: 0.72rem;
  color: var(--sl-text-2);
  margin-top: 0.15rem;
}

/* ── footer cta ─────────────────────────────────────────────────── */
.sl-sec--foot {
  background: var(--vp-c-bg-soft);
  border-top: 1px solid var(--vp-c-divider);
}
.sl-foot { max-width: 48rem; }
.sl-foot .sl-cta { margin-top: 1.5rem; }
.sl-foot__lead { font-size: clamp(1rem, 1.8vw, 1.15rem) !important; }
.sl-status {
  margin-top: 1.5rem;
  font-size: 0.85rem;
  color: var(--sl-text-2);
  max-width: 60ch;
}

/* visually hidden but accessible */
.sl-vh {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* ── responsive ─────────────────────────────────────────────────── */
@media (max-width: 860px) {
  .sl-hero__grid,
  .sl-split,
  .sl-split--rev { grid-template-columns: minmax(0, 1fr); }
  .sl-hero__code { order: 2; min-width: 0; }
  .sl-split--rev .sl-split__copy { order: 0; }
  .sl-lede { max-width: none; }
}
@media (max-width: 560px) {
  .sl-swap { grid-template-columns: 1fr; }
  .sl-swap__arrow { transform: rotate(90deg); margin-inline: auto; }
  .sl-wireboard__pkg { display: none; }
  .sl-lane { max-height: 172px; }
}

/* ── motion (enhances an already-visible default) ──────────────── */
@media (prefers-reduced-motion: no-preference) {
  .sl-home.armed .reveal {
    opacity: 0;
    transform: translateY(18px);
    transition: opacity 0.7s cubic-bezier(0.22, 1, 0.36, 1), transform 0.7s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .sl-home.armed .reveal.in {
    opacity: 1;
    transform: none;
  }
  .sl-wave-bg path {
    stroke-dasharray: 2400;
    stroke-dashoffset: 2400;
    animation: sl-draw 2.2s cubic-bezier(0.22, 1, 0.36, 1) 0.2s forwards;
  }
  .sl-h1,
  .sl-hero__code {
    animation: sl-rise 0.8s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .sl-hero__code { animation-delay: 0.12s; }
  .sl-cc-adapter { animation: sl-pulse 2.6s ease-in-out infinite; }
}
@keyframes sl-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--sl-cyan) 45%, transparent); }
  50% { box-shadow: 0 0 0 7px transparent; }
}
@keyframes sl-draw { to { stroke-dashoffset: 0; } }
@keyframes sl-rise {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: none; }
}
</style>
