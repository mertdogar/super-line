<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import DemoShell from './DemoShell.vue'

/* Tutorial 5's live result: REAL plugin-auth + plugin-chat merged onto one contract,
   in this tab. Sign-up runs the plugin's actual scrypt hashing (via the docs' crypto
   shim), mints a real session, and swaps the guest connection for an authed one —
   then plugin-chat's channels/membership/messages work as that user. Grace is a
   seeded user whose scripted replies go through the server-side chatKit, the same
   trusted door an AI agent uses. */

type Msg = { id: string; authorId: string; content: unknown; createdAt: number }
type AuthSnap = {
  status: 'guest' | 'authed'
  pending: boolean
  error: unknown
  userId: string | null
  displayName: string | null
  roles: string[]
}

const status = ref<'booting' | 'live' | 'failed' | 'offline'>('booting')
const auth = ref<AuthSnap>({ status: 'guest', pending: false, error: null, userId: null, displayName: null, roles: [] })
const timeline = reactive<string[]>([])
const hasAccount = ref(false)
const formError = ref('')
const email = ref('ada@example.com')
const password = ref('correct-horse-battery')
const displayName = ref('Ada')
const draft = ref('')
const busy = ref(false)
const rows = ref<Msg[]>([])
const chatReady = ref(false)
const feedEl = ref<HTMLElement | null>(null)

const names = reactive<Record<string, string>>({})
const authedAs = computed(() => (auth.value.status === 'authed' ? (auth.value.displayName ?? auth.value.userId) : null))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let contract: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chatKit: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let makeChatClient: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let authC: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cc: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let feed: any
let feedOff: (() => void) | undefined
let channelId = ''
let graceId = ''
let replyAt = 0
const cleanups: Array<() => void> = []

const GRACE_REPLIES = [
  'hey! that landed through a real membership check.',
  'the server stamped that id and timestamp, not your client.',
  'sign out and the whole surface goes idle — try it.',
]

function pushState(s: AuthSnap) {
  auth.value = { ...s }
  const label = s.pending
    ? 'pending…'
    : s.status === 'authed'
      ? `authed as ${s.displayName} (roles: ${s.roles.join(', ')})`
      : 'guest'
  if (timeline.at(-1) !== label) {
    timeline.push(label)
    if (timeline.length > 4) timeline.splice(0, timeline.length - 4)
  }
}

function scrollDown() {
  nextTick(() => {
    const el = feedEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function renderFeed() {
  if (!feed) return
  rows.value = [...(feed.rows() as Msg[])]
  scrollDown()
}

onMounted(async () => {
  try {
    const [{ defineContract }, { createSuperLineServer }, { createSuperLineClient }, { createLoopbackTransport }, { memoryCollections }, { authContract }, { auth: authFactory }, { authClient }, { chatContract }, { chat }, { chatClient }] =
      await Promise.all([
        import('@super-line/core'),
        import('@super-line/server'),
        import('@super-line/client'),
        import('@super-line/transport-loopback'),
        import('@super-line/collections-memory'),
        import('@super-line/plugin-auth'),
        import('@super-line/plugin-auth/server'),
        import('@super-line/plugin-auth/client'),
        import('@super-line/plugin-chat'),
        import('@super-line/plugin-chat/server'),
        import('@super-line/plugin-chat/client'),
      ])

    makeChatClient = chatClient
    contract = defineContract({
      roles: { user: {} },
      plugins: [authContract(), chatContract()],
    })

    const backend = memoryCollections()
    const authKit = authFactory({ contract, collections: backend, defaultRoles: ['user'] })
    chatKit = chat({ contract })

    const loop = createLoopbackTransport()
    const srv = createSuperLineServer(contract, {
      nodeKey: 'tutorial-5',
      transports: [loop.server],
      collections: backend,
      authenticate: authKit.authenticate,
      identify: authKit.identify,
      plugins: [authKit.plugin, chatKit.plugin],
    })
    cleanups.push(() => void srv.close())

    // Seed a teammate + a public channel with one message waiting.
    const grace = await authKit.users.create({ displayName: 'Grace' })
    graceId = grace.id
    names[grace.id] = 'Grace'
    const ch = await chatKit.channels.create({ name: 'welcome', visibility: 'public', owner: grace.id })
    channelId = ch.id
    await chatKit.messages.send({ channelId, authorId: grace.id, content: 'sign up and say hi 👋' })

    // The reader's auth lifecycle — in-memory token storage so a page reload never
    // replays a token against a fresh in-tab server.
    let stored: string | null = null
    authC = authClient({
      authedRole: 'user',
      connect: ({ role, params }: { role: string; params: Record<string, string> }) =>
        createSuperLineClient(contract, { transport: loop.client(), role: role as 'user', params }),
      storage: { get: () => stored, set: (t: string | null) => (stored = t) },
    })
    cleanups.push(() => void authC?.client?.close())
    cleanups.push(authC.subscribe((s: AuthSnap) => pushState(s)))
    await authC.ready
    pushState(authC.state)
    status.value = 'live'
  } catch {
    status.value = 'failed'
  }
})

async function openChat() {
  cc = makeChatClient(authC.client, { userId: authC.state.userId! })
  names[authC.state.userId!] = authC.state.displayName ?? 'you'
  await cc.join(channelId) // public channel → self-join
  feed = cc.messages(channelId)
  feedOff = feed.subscribe(renderFeed)
  await feed.ready
  chatReady.value = true
  renderFeed()
}

function closeChat() {
  feedOff?.()
  feedOff = undefined
  feed = undefined
  cc = undefined
  chatReady.value = false
  rows.value = []
}

async function submitAuth(mode: 'signUp' | 'signIn') {
  if (busy.value || status.value !== 'live') return
  busy.value = true
  formError.value = ''
  try {
    if (mode === 'signUp') {
      await authC.signUp({ email: email.value, password: password.value, displayName: displayName.value })
      hasAccount.value = true
    } else {
      await authC.signIn({ email: email.value, password: password.value })
    }
    await openChat()
  } catch (err) {
    const e = err as { code?: string; message?: string }
    formError.value = `${e.code ?? 'error'}: ${e.message ?? String(err)}`
  } finally {
    busy.value = false
  }
}

async function signOut() {
  if (busy.value || auth.value.status !== 'authed') return
  busy.value = true
  try {
    closeChat()
    await authC.signOut()
  } finally {
    busy.value = false
  }
}

async function send() {
  const text = draft.value.trim()
  if (!text || !chatReady.value || busy.value) return
  busy.value = true
  draft.value = ''
  try {
    await cc.send(channelId, text)
    const reply = GRACE_REPLIES[replyAt++ % GRACE_REPLIES.length]!
    setTimeout(() => {
      // Server-side co-write through the trusted kit — the same door an agent uses.
      void chatKit?.messages.send({ channelId, authorId: graceId, content: reply })
    }, 700)
  } catch {
    /* demo: a failed op just doesn't render */
  } finally {
    busy.value = false
  }
}

onBeforeUnmount(() => {
  closeChat()
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
    name="tutorial 5 · real sign-up, real session, whole chat domain"
    :status="status"
    real="the actual plugin-auth sign-up path — scrypt password hash, session mint, guest→user connection swap — and the actual plugin-chat membership/message model, on one merged contract. In-tab substitutions: the loopback wire, and Grace's replies are scripted (sent through the real server-side chatKit)."
  >
    <div class="ac-state" role="status" aria-label="Auth state timeline">
      <span v-for="(t, i) in timeline" :key="i" class="ac-step" :class="{ current: i === timeline.length - 1 }">
        {{ t }}<i v-if="i < timeline.length - 1" aria-hidden="true">→</i>
      </span>
    </div>

    <div v-if="auth.status !== 'authed'" class="ac-form-wrap">
      <form class="ac-form" @submit.prevent="submitAuth(hasAccount ? 'signIn' : 'signUp')">
        <label class="ac-label">
          <span>email</span>
          <input v-model="email" class="ds-field" type="email" autocomplete="off" :disabled="busy || status !== 'live'" />
        </label>
        <label class="ac-label">
          <span>password</span>
          <input v-model="password" class="ds-field" type="password" autocomplete="off" :disabled="busy || status !== 'live'" />
        </label>
        <label v-if="!hasAccount" class="ac-label">
          <span>display name</span>
          <input v-model="displayName" class="ds-field" type="text" autocomplete="off" :disabled="busy || status !== 'live'" />
        </label>
        <div class="ac-form-actions">
          <button class="ds-btn ds-btn--primary" type="submit" :disabled="busy || status !== 'live'">
            {{ hasAccount ? 'sign back in' : 'sign up' }}
          </button>
          <button
            v-if="hasAccount"
            class="ds-btn"
            type="button"
            :disabled="busy || status !== 'live'"
            @click="submitAuth('signUp')"
          >
            new account
          </button>
        </div>
        <p v-if="formError" class="ac-error" role="alert">{{ formError }}</p>
        <p class="ac-hint">the password is scrypt-hashed by the real plugin — in this tab</p>
      </form>
    </div>

    <template v-else>
      <div class="ac-chat">
        <header class="ac-head">
          <span class="ac-ch"># welcome</span>
          <span class="ac-me">you are <b>{{ authedAs }}</b></span>
          <button class="ds-btn" type="button" :disabled="busy" @click="signOut">sign out</button>
        </header>
        <div ref="feedEl" class="ac-feed" role="log" aria-live="polite" aria-label="Messages in #welcome">
          <p v-if="formError" class="ac-error" role="alert">{{ formError }}</p>
          <p v-else-if="!chatReady" class="ac-empty">joining #welcome…</p>
          <div
            v-for="m in rows"
            :key="m.id"
            class="ac-row"
            :class="{ self: m.authorId === auth.userId }"
          >
            <span class="ac-who">{{ names[m.authorId] ?? m.authorId }}</span>
            <span class="ac-bubble">{{ typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }}</span>
          </div>
        </div>
        <form class="ac-composer" @submit.prevent="send">
          <input
            v-model="draft"
            class="ds-field"
            type="text"
            placeholder="message #welcome"
            aria-label="message #welcome"
            :disabled="!chatReady || busy"
          />
          <button class="ds-btn ds-btn--primary" type="submit" :disabled="!chatReady || busy || !draft.trim()">
            send
          </button>
        </form>
      </div>
    </template>
  </DemoShell>
</template>

<style scoped>
.ac-state {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--sl-code-border);
  font-family: var(--vp-font-family-mono);
  font-size: 0.71rem;
  color: var(--sl-code-dim);
}
.ac-step i {
  font-style: normal;
  margin-left: 0.35rem;
  opacity: 0.6;
}
.ac-step.current {
  color: var(--sl-cyan-strong);
}
.ac-form-wrap {
  display: grid;
  place-items: center;
  padding: 1.2rem 0.9rem 1.4rem;
}
.ac-form {
  width: min(340px, 100%);
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.ac-label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.ac-label span {
  font-family: var(--vp-font-family-mono);
  font-size: 0.68rem;
  color: var(--sl-code-dim);
}
.ac-form-actions {
  display: flex;
  gap: 0.45rem;
  margin-top: 0.2rem;
}
.ac-error {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  color: #f0b3a0;
  overflow-wrap: anywhere;
}
.ac-hint {
  margin: 0;
  font-size: 0.72rem;
  color: var(--sl-code-dim);
}
.ac-chat {
  display: flex;
  flex-direction: column;
  height: 320px;
}
.ac-head {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.55rem 0.9rem;
  border-bottom: 1px solid var(--sl-code-border);
  background: var(--sl-code-bg-2);
}
.ac-ch {
  font-weight: 700;
  font-size: 0.9rem;
  color: var(--sl-code-fn);
}
.ac-me {
  margin-right: auto;
  font-size: 0.74rem;
  color: var(--sl-code-dim);
}
.ac-me b {
  color: var(--sl-code-text);
  font-weight: 600;
}
.ac-feed {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.75rem 0.9rem;
}
.ac-empty {
  margin: auto;
  font-size: 0.78rem;
  color: var(--sl-code-dim);
}
.ac-row {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  max-width: 84%;
}
.ac-row.self {
  align-self: flex-end;
  align-items: flex-end;
}
.ac-who {
  font-size: 0.7rem;
  color: var(--sl-code-dim);
  padding-inline: 0.1rem;
}
.ac-bubble {
  padding: 0.45rem 0.7rem;
  border-radius: 11px;
  font-size: 0.85rem;
  line-height: 1.45;
  color: var(--sl-code-text);
  background: var(--sl-code-bg-2);
  border: 1px solid var(--sl-code-border);
  overflow-wrap: anywhere;
}
.ac-row.self .ac-bubble {
  background: color-mix(in oklab, var(--sl-cyan) 15%, var(--sl-code-bg-2));
  border-color: color-mix(in oklab, var(--sl-cyan) 34%, var(--sl-code-border));
}
.ac-composer {
  display: flex;
  gap: 0.45rem;
  padding: 0.55rem 0.9rem 0.75rem;
  border-top: 1px solid var(--sl-code-border);
}
.ac-composer .ds-field {
  flex: 1;
}
</style>
