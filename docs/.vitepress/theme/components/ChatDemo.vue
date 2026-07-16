<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

/* Two-up showpiece for the chat plugin: the contract wiring (left) and a REAL
   running instance (right). Like ClusterDemo, this boots actual super-line in the
   tab — @super-line/plugin-chat over the loopback transport, backed by
   collections-memory. You send real messages through the plugin's typed requests;
   the "Ask AI" agent replies through the same server-authoritative chatKit API and
   performs real management calls (create_channel). Identity is simplified for a
   self-contained widget (a tiny inline `users` table + a trivial authenticate)
   rather than the full plugin-auth login shown in the code panel. */

const wiring = `<span class="c">// one contract — merge whole domains as plugins</span>
<span class="k">const</span> app = <span class="f">defineContract</span>({
  roles: { user: {} },
  plugins: [<span class="f">authContract</span>(), <span class="f">chatContract</span>()],
})

<span class="c">// server — each plugin owns its policies + handlers</span>
plugins: [authKit.plugin, <span class="hl">chatKit.plugin</span>],

<span class="c">// an AI agent is just a user — on the same wire,</span>
<span class="c">// with the same typed surface, server-authorized</span>
<span class="k">const</span> agent = <span class="k">new</span> <span class="f">ToolLoopAgent</span>({
  model: <span class="s">'anthropic/claude-sonnet-5'</span>,
  tools: <span class="f">chatAgentTools</span>(client), <span class="c">// its own connection</span>
})`

// ── live-instance state ────────────────────────────────────────────────────────
type Anno =
  | { kind: 'tool'; ts: number; seq: number; who: string; call: string }
  | { kind: 'sys'; ts: number; seq: number; text: string }
type MsgItem = { kind: 'msg' | 'agent'; ts: number; seq: number; id: string; who: string; self: boolean; text: string }
type Item = MsgItem | Anno

const ME = 'ada'
const AGENT = 'ask-ai'
const NAMES: Record<string, string> = { ada: 'ada', grace: 'grace', 'ask-ai': 'Ask AI' }

const booted = ref(false)
const failed = ref(false)
const busy = ref(false)
const typing = ref(false)
const draft = ref('')
const version = ref(0) // bumped on every live-store change to re-read rows
const annos = reactive<Anno[]>([])
const feedEl = ref<HTMLElement | null>(null)

const chips = [
  { label: 'which transports?', text: 'which transports can it run over?' },
  { label: 'is it typed?', text: 'is it typed end to end?' },
  { label: 'open a channel', text: 'open a #transports channel' },
]

let seq = 0
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chatKit: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cc: any
// the ONE live message store — created in boot, never re-created (each cc.messages()
// call opens a fresh subscription, so calling it inside a computed would loop)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let feed: any
let channelId = ''
const cleanups: Array<() => void> = []

const reduced = () =>
  typeof window === 'undefined' ||
  !window.matchMedia('(prefers-reduced-motion: no-preference)').matches

const wait = (ms: number) => new Promise((r) => setTimeout(r, reduced() ? 0 : ms))

// The rendered stream: real message rows from the live store, merged with the
// agent's tool-call / system annotations, ordered by (timestamp, seq).
const timeline = computed<Item[]>(() => {
  void version.value
  if (!feed) return []
  const rows = (feed.rows?.() ?? []) as Array<{
    id: string
    authorId: string
    content: unknown
    createdAt: number
  }>
  const msgs: Item[] = rows.map((r, i) => ({
    kind: r.authorId === AGENT ? 'agent' : 'msg',
    ts: r.createdAt,
    seq: i,
    id: r.id,
    who: NAMES[r.authorId] ?? r.authorId,
    self: r.authorId === ME,
    text: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
  }))
  return [...msgs, ...annos].sort((a, b) => a.ts - b.ts || a.seq - b.seq)
})

const onlineCount = computed(() => {
  void version.value
  return 3
})

function scrollDown() {
  nextTick(() => {
    const el = feedEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function pushTool(call: string) {
  annos.push({ kind: 'tool', ts: Date.now(), seq: seq++, who: NAMES[AGENT], call })
  scrollDown()
}
function pushSys(text: string) {
  annos.push({ kind: 'sys', ts: Date.now(), seq: seq++, text })
  scrollDown()
}

// The agent's turn: scripted intent (no live LLM in a docs page), but every move is
// a REAL plugin request — a message send, and for some prompts a create_channel.
async function agentTurn(prompt: string) {
  const p = prompt.toLowerCase()
  let reply = 'Good question — I can read the channel and act on it with typed tools.'
  let tool = 'read_messages'
  let makeChannel = false
  // check the "open/create a channel" intent first — it can also mention transports
  if (p.includes('open') || p.includes('create') || p.includes('channel')) {
    reply = "On it — I'll spin up #transports and add you."
    tool = 'create_channel'
    makeChannel = true
  } else if (p.includes('transport') || p.includes('wire')) {
    reply = 'WebSocket, HTTP, or libp2p — the same code on every wire.'
  } else if (p.includes('type') || p.includes('codegen')) {
    reply = 'Yes — one contract types the client, the server, and me. Zero codegen.'
  }

  pushTool(tool)
  typing.value = true
  await wait(620)
  typing.value = false
  await chatKit.messages.send({ channelId, authorId: AGENT, content: reply })
  scrollDown()

  if (makeChannel) {
    await wait(360)
    pushTool('add_member')
    const t = await chatKit.channels.create({ name: 'transports', visibility: 'public', owner: AGENT })
    await chatKit.members.add(t.id, ME)
    pushSys('Ask AI created #transports · added ada')
  }
}

async function submit(text: string) {
  const body = text.trim()
  if (!body || !booted.value || busy.value) return
  busy.value = true
  draft.value = ''
  try {
    await cc.send(channelId, body) // real client request, as ada
    scrollDown()
    await agentTurn(body)
  } catch {
    // demo: a failed op just doesn't render
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    const { defineContract } = await import('@super-line/core')
    const { z } = await import('zod')
    const { createSuperLineServer } = await import('@super-line/server')
    const { createSuperLineClient } = await import('@super-line/client')
    const { createLoopbackTransport } = await import('@super-line/transport-loopback')
    const { memoryCollections } = await import('@super-line/collections-memory')
    const { chatContract } = await import('@super-line/plugin-chat')
    const { chat } = await import('@super-line/plugin-chat/server')
    const { chatClient } = await import('@super-line/plugin-chat/client')

    // A minimal identity table satisfies the plugin's `users` requirement without
    // pulling the full plugin-auth login into a marketing widget.
    const app = defineContract({
      roles: { user: {} },
      collections: { users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' } },
      plugins: [chatContract()],
    })

    const backend = memoryCollections()
    chatKit = chat({ contract: app })
    const loop = createLoopbackTransport()
    const srv = createSuperLineServer(app, {
      transports: [loop.server],
      collections: backend,
      authenticate: (h: { query?: Record<string, string> }) => ({
        role: 'user' as const,
        ctx: { userId: h.query?.userId ?? 'anon', roles: ['user'], sessionId: 's' },
      }),
      identify: (conn: { ctx?: unknown }) => (conn.ctx as { userId?: string } | undefined)?.userId,
      plugins: [chatKit.plugin],
    })
    cleanups.push(() => void srv.close?.())

    for (const [id, name] of [
      ['ada', 'Ada'],
      ['grace', 'Grace'],
      ['ask-ai', 'Ask AI'],
    ] as const) {
      await srv.collection('users').insert({ id, name })
    }

    const ch = await chatKit.channels.create({ name: 'ask-ai', visibility: 'public', owner: ME })
    channelId = ch.id
    await chatKit.members.add(ch.id, 'grace')
    await chatKit.members.add(ch.id, AGENT)
    await chatKit.messages.send({ channelId: ch.id, authorId: 'grace', content: 'anyone tried the new chat plugin?' })

    const client = createSuperLineClient(app, {
      transport: loop.client(),
      role: 'user',
      params: { userId: ME },
    })
    cleanups.push(() => void client.close?.())
    cc = chatClient(client, { userId: ME })

    feed = cc.messages(ch.id)
    const off = feed.subscribe(() => {
      version.value++
      scrollDown()
    })
    cleanups.push(() => off?.())
    await feed.ready
    version.value++
    booted.value = true
    scrollDown()
  } catch {
    failed.value = true
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
  <div class="cd">
    <!-- left: the wiring + bridge -->
    <div class="cd-left">
      <div class="cd-win">
        <div class="cd-win__bar">
          <span class="cd-win__dot" /><span class="cd-win__dot" /><span class="cd-win__dot" />
          <span class="cd-win__name">contract.ts + server.ts</span>
        </div>
        <pre class="cd-pre"><code v-html="wiring" /></pre>
      </div>

      <p class="cd-bridge" aria-hidden="true">
        <span class="cd-bridge__mark">chatContract()</span>
        <span class="cd-bridge__arrow">types both →</span>
      </p>
    </div>

    <!-- right: the REAL running app -->
    <div class="cd-app" :class="{ booted }">
      <div class="cd-app__head">
        <span class="cd-app__ch"># ask-ai</span>
        <span class="cd-app__pres">
          <i class="cd-dot" :class="{ off: !booted }" aria-hidden="true" />{{ onlineCount }} online · you are
          <b>ada</b>
        </span>
      </div>

      <div ref="feedEl" class="cd-feed" role="log" aria-live="polite" aria-label="Live #ask-ai messages">
        <template v-for="it in timeline" :key="it.kind + it.ts + it.seq">
          <div
            v-if="it.kind === 'msg' || it.kind === 'agent'"
            class="cd-row"
            :class="{ 'cd-row--self': it.self, 'cd-row--agent': it.kind === 'agent' }"
          >
            <template v-if="it.kind === 'agent'">
              <span class="cd-who cd-who--agent">
                <i class="cd-bot" aria-hidden="true">✦</i>{{ it.who }}
                <em class="cd-tag">agent</em>
              </span>
              <span class="cd-bubble cd-bubble--agent">{{ it.text }}</span>
            </template>
            <template v-else>
              <span class="cd-who">{{ it.who }}</span>
              <span class="cd-bubble">{{ it.text }}</span>
            </template>
          </div>

          <span v-else-if="it.kind === 'tool'" class="cd-tool">
            <i aria-hidden="true">▸</i> {{ it.who }} called <code>{{ it.call }}</code>
          </span>

          <span v-else class="cd-sys">{{ it.text }}</span>
        </template>

        <div v-if="typing" class="cd-row cd-row--agent">
          <span class="cd-typing" aria-hidden="true"><i /><i /><i /></span>
        </div>

        <p v-if="!booted && !failed" class="cd-boot">connecting a live super-line instance…</p>
        <p v-if="failed" class="cd-boot">demo couldn't start in this browser — the code on the left is the real wiring.</p>
      </div>

      <div class="cd-quick" role="group" aria-label="Quick messages">
        <button
          v-for="c in chips"
          :key="c.label"
          type="button"
          class="cd-chip"
          :disabled="!booted || busy"
          @click="submit(c.text)"
        >
          {{ c.label }}
        </button>
      </div>

      <form class="cd-composer" @submit.prevent="submit(draft)">
        <input
          v-model="draft"
          class="cd-composer__field"
          type="text"
          :disabled="!booted || busy"
          placeholder="Message #ask-ai"
          aria-label="Message #ask-ai as ada"
        />
        <button class="cd-composer__send" type="submit" :disabled="!booted || busy || !draft.trim()">Send</button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.cd {
  margin-top: clamp(1.6rem, 3.5vw, 2.4rem);
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
  gap: clamp(1.25rem, 3.5vw, 2.75rem);
  align-items: start;
}
.cd-left {
  display: flex;
  flex-direction: column;
  gap: clamp(0.9rem, 2vw, 1.35rem);
  min-width: 0;
}

/* ── shared dark-panel chrome (matches the home's code windows) ── */
.cd-win,
.cd-app {
  border-radius: 16px;
  background: var(--sl-code-bg);
  border: 1px solid var(--sl-code-border);
  box-shadow: 0 24px 60px -30px rgba(2, 12, 20, 0.7), 0 2px 10px -4px rgba(2, 12, 20, 0.5);
  overflow: hidden;
}
:global(.dark) .cd-win,
:global(.dark) .cd-app {
  border-color: #2a3441;
  box-shadow: 0 0 0 1px #05070a, 0 24px 60px -30px rgba(0, 0, 0, 0.9), 0 2px 10px -4px rgba(0, 0, 0, 0.6);
}

/* ── left: code window ── */
.cd-win {
  min-width: 0;
}
.cd-win__bar {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.7rem 0.95rem;
  background: var(--sl-code-bg-2);
  border-bottom: 1px solid var(--sl-code-border);
}
.cd-win__dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #2c3744;
}
.cd-win__dot:first-child { background: #3a4654; }
.cd-win__name {
  margin-left: 0.5rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  color: var(--sl-code-dim);
}
.cd-pre {
  margin: 0;
  padding: 1.1rem 1.2rem;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: clamp(0.72rem, 0.88vw, 0.8rem);
  line-height: 1.7;
  color: var(--sl-code-text);
  tab-size: 2;
}
.cd-pre code {
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  font-size: inherit;
}
.cd-pre :deep(.c) { color: var(--sl-code-dim); font-style: italic; }
.cd-pre :deep(.k) { color: var(--sl-code-key); }
.cd-pre :deep(.s) { color: var(--sl-code-str); }
.cd-pre :deep(.f) { color: var(--sl-code-fn); }
.cd-pre :deep(.hl) {
  border-radius: 4px;
  padding: 0.06em 0.34em;
  color: var(--sl-code-str);
  background: color-mix(in oklab, var(--sl-cyan) 16%, transparent);
}

/* ── bridge annotation ── */
.cd-bridge {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex-wrap: wrap;
  font-size: 0.82rem;
  line-height: 1.4;
  color: var(--sl-text-2);
}
.cd-bridge__mark {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--sl-cyan-strong);
  padding: 0.14rem 0.5rem;
  border-radius: 6px;
  background: color-mix(in oklab, var(--sl-cyan) 12%, transparent);
  border: 1px solid color-mix(in oklab, var(--sl-cyan) 32%, var(--vp-c-divider));
}
.cd-bridge__arrow { font-weight: 500; }

/* ── right: chat app ── */
.cd-app {
  display: flex;
  flex-direction: column;
  height: clamp(440px, 52vw, 520px);
  opacity: 0.75;
  transition: opacity 0.4s ease;
}
.cd-app.booted { opacity: 1; }
.cd-app__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1.05rem;
  border-bottom: 1px solid var(--sl-code-border);
  background: var(--sl-code-bg-2);
  flex: none;
}
.cd-app__ch {
  font-weight: 700;
  font-size: 0.96rem;
  letter-spacing: -0.01em;
  color: var(--sl-code-fn);
}
.cd-app__pres {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.76rem;
  color: var(--sl-code-dim);
}
.cd-app__pres b { color: var(--sl-code-text); font-weight: 600; }
.cd-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--sl-cyan-bright);
  flex: none;
}
.cd-dot.off { background: #3a4654; }

.cd-feed {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem 1.05rem;
  overflow-y: auto;
  scroll-behavior: smooth;
}
.cd-row {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  max-width: 82%;
}
.cd-row--self { align-self: flex-end; align-items: flex-end; }

.cd-who {
  font-size: 0.72rem;
  color: var(--sl-code-dim);
  padding-inline: 0.15rem;
}
.cd-who--agent {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--sl-cyan-strong);
  font-weight: 600;
}
.cd-bot { font-style: normal; color: var(--sl-cyan-bright); }
.cd-tag {
  font-style: normal;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--sl-on-cyan);
  background: var(--sl-cyan-bright);
  padding: 0.05rem 0.32rem;
  border-radius: 999px;
}
.cd-bubble {
  padding: 0.5rem 0.75rem;
  border-radius: 12px;
  font-size: 0.88rem;
  line-height: 1.45;
  color: var(--sl-code-text);
  background: var(--sl-code-bg-2);
  border: 1px solid var(--sl-code-border);
}
.cd-row--self .cd-bubble {
  background: color-mix(in oklab, var(--sl-cyan) 15%, var(--sl-code-bg-2));
  border-color: color-mix(in oklab, var(--sl-cyan) 34%, var(--sl-code-border));
}
.cd-bubble--agent {
  background: color-mix(in oklab, var(--sl-cyan) 7%, var(--sl-code-bg-2));
  border-color: color-mix(in oklab, var(--sl-cyan) 26%, var(--sl-code-border));
}

.cd-tool {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  align-self: flex-start;
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  color: var(--sl-code-dim);
  padding: 0.32rem 0.6rem;
  border-radius: 8px;
  background: color-mix(in oklab, var(--sl-cyan) 8%, transparent);
  border: 1px dashed color-mix(in oklab, var(--sl-cyan) 34%, var(--sl-code-border));
}
.cd-tool i { color: var(--sl-cyan-bright); font-style: normal; }
.cd-tool code {
  color: var(--sl-code-str);
  background: none;
  border: 0;
  padding: 0;
  font-size: 1em;
}
.cd-sys {
  align-self: center;
  text-align: center;
  font-size: 0.74rem;
  color: var(--sl-code-dim);
}
.cd-boot {
  margin: auto;
  font-size: 0.8rem;
  color: var(--sl-code-dim);
  text-align: center;
}

.cd-typing {
  display: inline-flex;
  gap: 0.22rem;
  padding: 0.55rem 0.7rem;
  border-radius: 12px;
  background: color-mix(in oklab, var(--sl-cyan) 7%, var(--sl-code-bg-2));
  border: 1px solid color-mix(in oklab, var(--sl-cyan) 26%, var(--sl-code-border));
}
.cd-typing i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--sl-cyan-bright);
  opacity: 0.5;
}

/* ── quick-ask chips ── */
.cd-quick {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0.55rem 0.85rem 0;
  flex: none;
}
.cd-chip {
  appearance: none;
  font: 500 0.76rem/1 var(--vp-font-family-base);
  color: var(--sl-code-text);
  background: var(--sl-code-bg-2);
  border: 1px solid var(--sl-code-border);
  padding: 0.4rem 0.7rem;
  border-radius: 999px;
  cursor: pointer;
  transition: border-color 0.16s, background-color 0.16s, color 0.16s;
}
.cd-chip:hover:not(:disabled) {
  border-color: var(--sl-cyan);
  color: var(--sl-cyan-strong);
  background: color-mix(in oklab, var(--sl-cyan) 10%, var(--sl-code-bg-2));
}
.cd-chip:focus-visible {
  outline: 2px solid var(--sl-cyan-bright);
  outline-offset: 2px;
}
.cd-chip:disabled { opacity: 0.5; cursor: default; }

/* ── composer ── */
.cd-composer {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.7rem 0.85rem;
  border-top: 1px solid var(--sl-code-border);
  background: var(--sl-code-bg-2);
  flex: none;
}
.cd-composer__field {
  flex: 1;
  min-width: 0;
  padding: 0.55rem 0.7rem;
  border-radius: 9px;
  background: var(--sl-code-bg);
  border: 1px solid var(--sl-code-border);
  font: inherit;
  font-size: 0.85rem;
  color: var(--sl-code-text);
}
.cd-composer__field::placeholder { color: var(--sl-code-dim); }
.cd-composer__field:focus-visible {
  outline: none;
  border-color: var(--sl-cyan);
}
.cd-composer__field:disabled { opacity: 0.6; }
.cd-composer__send {
  flex: none;
  padding: 0.55rem 0.95rem;
  border: 0;
  border-radius: 9px;
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--sl-on-cyan);
  background: var(--sl-cyan-bright);
  cursor: pointer;
  transition: filter 0.16s, opacity 0.16s;
}
.cd-composer__send:hover:not(:disabled) { filter: brightness(1.08); }
.cd-composer__send:focus-visible { outline: 2px solid var(--sl-cyan-bright); outline-offset: 2px; }
.cd-composer__send:disabled { opacity: 0.45; cursor: default; }

/* ── motion ── */
@media (prefers-reduced-motion: no-preference) {
  .cd-row {
    animation: cd-in 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .cd-dot:not(.off) {
    animation: cd-pulse 2.2s ease-out infinite;
  }
  .cd-typing i {
    animation: cd-think 1.1s ease-out infinite;
  }
  .cd-typing i:nth-child(2) { animation-delay: 0.15s; }
  .cd-typing i:nth-child(3) { animation-delay: 0.3s; }
}
@keyframes cd-in {
  from { opacity: 0; transform: translateY(9px); }
  to { opacity: 1; transform: none; }
}
@keyframes cd-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--sl-cyan-bright) 45%, transparent); }
  70% { box-shadow: 0 0 0 7px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@keyframes cd-think {
  0%, 100% { opacity: 0.35; transform: scale(0.82); }
  50% { opacity: 1; transform: scale(1); }
}

/* ── responsive: stack, code first then the app ── */
@media (max-width: 880px) {
  .cd {
    grid-template-columns: minmax(0, 1fr);
  }
  .cd-app { height: clamp(420px, 120vw, 500px); }
}
</style>
