<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import DemoShell from './DemoShell.vue'

/* Tutorial 2's live result: the tutorial-1 server plus TWO real clients (ada and
   bob), each doing all three wire patterns — the join/send requests, the message
   event, and the presence topic. The "send an invalid payload" button proves the
   server re-validates every inbound frame regardless of what TypeScript said. */

type FeedItem = { id: number; kind: 'msg' | 'sys'; from?: string; text: string }
type Pane = {
  name: string
  joined: boolean
  subscribed: boolean
  presence: string
  draft: string
  feed: FeedItem[]
}

const status = ref<'booting' | 'live' | 'failed' | 'offline'>('booting')
const invalidResult = ref('')
const panes = reactive<Record<string, Pane>>({
  ada: { name: 'ada', joined: false, subscribed: true, presence: 'no presence yet', draft: '', feed: [] },
  bob: { name: 'bob', joined: false, subscribed: true, presence: 'no presence yet', draft: '', feed: [] },
})

let seq = 0
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clients = new Map<string, any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const presenceSubs = new Map<string, any>()
const cleanups: Array<() => void> = []
const feedEls = new Map<string, HTMLElement>()

function setFeedEl(name: string, el: unknown) {
  if (el instanceof HTMLElement) feedEls.set(name, el)
}

function append(pane: Pane, item: Omit<FeedItem, 'id'>) {
  pane.feed.push({ id: seq++, ...item })
  if (pane.feed.length > 60) pane.feed.splice(0, pane.feed.length - 60)
  requestAnimationFrame(() => {
    const el = feedEls.get(pane.name)
    if (el) el.scrollTop = el.scrollHeight
  })
}

function subscribePresence(name: string) {
  const client = clients.get(name)
  const pane = panes[name]!
  const sub = client.subscribe('presence', (p: { room: string; count: number }) => {
    pane.presence = `${p.count} online in #${p.room}`
  })
  presenceSubs.set(name, sub)
  pane.subscribed = true
}

async function boot() {
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

    const loop = createLoopbackTransport()
    const srv = createSuperLineServer(contract, {
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

    for (const name of ['ada', 'bob']) {
      const client = createSuperLineClient(contract, {
        transport: loop.client(),
        role: 'user',
        params: { name },
      })
      clients.set(name, client)
      cleanups.push(() => void client.close())
      const pane = panes[name]!
      client.on('message', (m: { text: string; from: string }) => {
        append(pane, { kind: 'msg', from: m.from, text: m.text })
      })
      subscribePresence(name)
    }

    status.value = 'live'
  } catch {
    status.value = 'failed'
  }
}

async function join(name: string) {
  const pane = panes[name]!
  if (status.value !== 'live' || pane.joined) return
  try {
    const res = await clients.get(name).join({ room: 'lobby' })
    pane.joined = true
    append(pane, { kind: 'sys', text: `join('lobby') → ${JSON.stringify(res)}` })
  } catch {
    /* demo: a failed op just doesn't render */
  }
}

async function send(name: string) {
  const pane = panes[name]!
  const text = pane.draft.trim()
  if (!text || status.value !== 'live') return
  pane.draft = ''
  try {
    await clients.get(name).send({ room: 'lobby', text })
  } catch {
    /* demo: a failed op just doesn't render */
  }
}

function togglePresence(name: string) {
  const pane = panes[name]!
  if (pane.subscribed) {
    presenceSubs.get(name)?.unsubscribe()
    presenceSubs.delete(name)
    pane.subscribed = false
    pane.presence = 'presence topic off — deliveries stopped'
  } else {
    subscribePresence(name)
    pane.presence = 'resubscribed — waiting for the next push'
  }
}

async function sendInvalid() {
  if (status.value !== 'live') return
  try {
    // What TypeScript won't let you write, the wire can still carry — send it anyway.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (clients.get('ada') as any).send({ room: 'lobby', text: 42 })
    invalidResult.value = 'unexpectedly accepted?!'
  } catch (err) {
    const e = err as { code?: string; message?: string }
    invalidResult.value = `rejected — ${e.code ?? 'error'}: ${e.message ?? String(err)}`
  }
}

onMounted(boot)
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
    name="tutorial 2 · two clients, three wire patterns"
    :status="status"
    real="the same server as Tutorial 1 plus two real createSuperLineClient connections — real requests, a real pushed event, a real topic subscription, and real server-side validation on the invalid send. In-tab substitution: the loopback wire instead of WebSocket."
  >
    <div class="rt-grid">
      <section v-for="pane in panes" :key="pane.name" class="rt-pane" :aria-label="'client ' + pane.name">
        <header class="rt-head">
          <span class="rt-who">{{ pane.name }}</span>
          <button
            class="rt-topic"
            type="button"
            :disabled="status !== 'live'"
            :aria-pressed="pane.subscribed"
            :title="pane.subscribed ? 'unsubscribe from the presence topic' : 'subscribe to the presence topic'"
            @click="togglePresence(pane.name)"
          >
            {{ pane.subscribed ? '◉ presence' : '○ presence' }}
          </button>
        </header>
        <p class="rt-presence">{{ pane.presence }}</p>
        <div :ref="(el) => setFeedEl(pane.name, el)" class="rt-feed" role="log" aria-live="polite">
          <p v-if="pane.feed.length === 0 && !pane.joined" class="rt-empty">
            not in a room yet — join to receive broadcasts
          </p>
          <p v-for="it in pane.feed" :key="it.id" class="rt-item" :class="'is-' + it.kind">
            <template v-if="it.kind === 'msg'"><b>{{ it.from }}:</b> {{ it.text }}</template>
            <template v-else>{{ it.text }}</template>
          </p>
        </div>
        <div class="rt-actions">
          <button v-if="!pane.joined" class="ds-btn" type="button" :disabled="status !== 'live'" @click="join(pane.name)">
            join('lobby')
          </button>
          <form v-else class="rt-composer" @submit.prevent="send(pane.name)">
            <input
              v-model="pane.draft"
              class="ds-field"
              type="text"
              :placeholder="'send as ' + pane.name"
              :aria-label="'message from ' + pane.name"
              :disabled="status !== 'live'"
            />
            <button class="ds-btn ds-btn--primary" type="submit" :disabled="status !== 'live' || !pane.draft.trim()">
              send
            </button>
          </form>
        </div>
      </section>
    </div>

    <footer class="rt-foot">
      <button class="ds-btn" type="button" :disabled="status !== 'live'" @click="sendInvalid">
        send an invalid payload (text: 42)
      </button>
      <span v-if="invalidResult" class="rt-invalid" role="status">{{ invalidResult }}</span>
    </footer>
  </DemoShell>
</template>

<style scoped>
.rt-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.rt-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.rt-pane + .rt-pane {
  border-left: 1px solid var(--sl-code-border);
}
.rt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.6rem 0.85rem 0.15rem;
}
.rt-who {
  font-weight: 700;
  font-size: 0.86rem;
  color: var(--sl-code-fn);
}
.rt-topic {
  appearance: none;
  border: 0;
  background: none;
  padding: 0.15rem 0.3rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  color: var(--sl-cyan-strong);
  cursor: pointer;
  border-radius: 6px;
}
.rt-topic[aria-pressed='false'] {
  color: var(--sl-code-dim);
}
.rt-topic:focus-visible {
  outline: 2px solid var(--sl-cyan-bright);
  outline-offset: 2px;
}
.rt-topic:disabled {
  opacity: 0.5;
  cursor: default;
}
.rt-presence {
  margin: 0;
  padding: 0 0.85rem 0.4rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.71rem;
  color: var(--sl-code-dim);
  min-height: 1.4em;
}
.rt-feed {
  height: 168px;
  overflow-y: auto;
  padding: 0.5rem 0.85rem;
  border-top: 1px solid var(--sl-code-border);
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.rt-empty {
  margin: auto;
  font-size: 0.76rem;
  color: var(--sl-code-dim);
  text-align: center;
}
.rt-item {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--sl-code-text);
  overflow-wrap: anywhere;
}
.rt-item b {
  color: var(--sl-cyan-strong);
  font-weight: 600;
}
.rt-item.is-sys {
  font-family: var(--vp-font-family-mono);
  font-size: 0.71rem;
  color: var(--sl-code-dim);
}
.rt-actions {
  padding: 0.55rem 0.85rem 0.75rem;
  border-top: 1px solid var(--sl-code-border);
}
.rt-composer {
  display: flex;
  gap: 0.45rem;
}
.rt-composer .ds-field {
  flex: 1;
}
.rt-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
  padding: 0.65rem 0.85rem;
  border-top: 1px solid var(--sl-code-border);
  background: var(--sl-code-bg-2);
}
.rt-invalid {
  font-family: var(--vp-font-family-mono);
  font-size: 0.73rem;
  color: #f0b3a0;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .rt-grid {
    grid-template-columns: 1fr;
  }
  .rt-pane + .rt-pane {
    border-left: 0;
    border-top: 1px solid var(--sl-code-border);
  }
}
</style>
