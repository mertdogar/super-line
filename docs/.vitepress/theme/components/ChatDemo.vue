<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/* Two-up showpiece for the chat plugin: the contract wiring (left) and the
   running app it produces (right). One `chatContract()` types the client, the
   server handlers, AND the LLM agent's tools — so a human and an AI agent talk
   over the exact same surface. All API is real super-line (verified against
   plugin-chat + plugin-auth READMEs / how-tos): defineContract({ plugins }),
   chatKit.plugin / authKit.plugin, ToolLoopAgent + chatAgentTools(client).
   The chat panel is a scripted illustration — the tool-call rows (read_messages
   / create_channel) are real names from the `/ai` toolset. */

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

type Line =
  | { kind: 'msg'; who: string; self?: boolean; text: string }
  | { kind: 'agent'; who: string; text: string }
  | { kind: 'tool'; who: string; call: string }
  | { kind: 'sys'; text: string }

const script: Line[] = [
  { kind: 'msg', who: 'grace', text: 'anyone tried the new chat plugin yet?' },
  { kind: 'msg', who: 'ada', self: true, text: 'yeah — channels, membership + messages, all on one contract' },
  { kind: 'msg', who: 'ada', self: true, text: '@Ask AI which transports can it run over?' },
  { kind: 'tool', who: 'Ask AI', call: 'read_messages' },
  { kind: 'agent', who: 'Ask AI', text: 'WebSocket, HTTP, or libp2p — the same code on every wire.' },
  { kind: 'agent', who: 'Ask AI', text: "Want a #transports channel? I'll set it up." },
  { kind: 'tool', who: 'Ask AI', call: 'create_channel' },
  { kind: 'sys', text: 'Ask AI created #transports · added grace, ada' },
]

// Default: everything visible (SSR / no-JS / reduced-motion — content is never
// gated behind the animation). Motion just replays it as an arriving conversation.
const shown = ref(script.length)
const typing = ref(false)
const root = ref<HTMLElement | null>(null)
const feed = ref<HTMLElement | null>(null)

let io: IntersectionObserver | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let cancelled = false

const reduced = () =>
  typeof window === 'undefined' ||
  !window.matchMedia('(prefers-reduced-motion: no-preference)').matches

function toBottom() {
  const el = feed.value
  if (el) el.scrollTop = el.scrollHeight
}

function step(i: number) {
  if (cancelled) return
  if (i >= script.length) {
    typing.value = false
    return
  }
  const line = script[i]
  const showNext = () => {
    typing.value = false
    shown.value = i + 1
    requestAnimationFrame(toBottom)
    timer = setTimeout(() => step(i + 1), line.kind === 'sys' ? 780 : 940)
  }
  // the agent "thinks" before it speaks or acts
  if (line.kind === 'agent' || line.kind === 'tool') {
    typing.value = true
    requestAnimationFrame(toBottom)
    timer = setTimeout(showNext, 680)
  } else {
    showNext()
  }
}

function play() {
  cancelled = false
  shown.value = 0
  typing.value = false
  timer = setTimeout(() => step(0), 420)
}

onMounted(() => {
  if (reduced()) {
    requestAnimationFrame(toBottom)
    return
  }
  const el = root.value
  if (!el) return
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          io?.disconnect()
          io = null
          play()
        }
      }
    },
    { threshold: 0.35 },
  )
  io.observe(el)
})

onBeforeUnmount(() => {
  cancelled = true
  io?.disconnect()
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div ref="root" class="cd">
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

    <!-- right: the running app -->
    <div
      class="cd-app"
      role="img"
      aria-label="A scripted chat in an #ask-ai channel: grace and ada talk, then the AI agent 'Ask AI' calls read_messages, answers that super-line runs over WebSocket, HTTP or libp2p, then calls create_channel to open a #transports channel and add grace and ada — a human and an AI agent over the one super-line contract."
    >
      <div class="cd-app__head">
        <span class="cd-app__ch"># ask-ai</span>
        <span class="cd-app__pres">
          <i class="cd-dot" aria-hidden="true" />3 online · you are <b>ada</b>
        </span>
      </div>

      <div ref="feed" class="cd-feed">
        <template v-for="(line, i) in script" :key="i">
          <div
            v-if="i < shown"
            class="cd-row"
            :class="[
              `cd-row--${line.kind}`,
              { 'cd-row--self': line.kind === 'msg' && line.self },
            ]"
          >
            <!-- human / self message -->
            <template v-if="line.kind === 'msg'">
              <span class="cd-who">{{ line.who }}</span>
              <span class="cd-bubble">{{ line.text }}</span>
            </template>

            <!-- agent message -->
            <template v-else-if="line.kind === 'agent'">
              <span class="cd-who cd-who--agent">
                <i class="cd-bot" aria-hidden="true">✦</i>{{ line.who }}
                <em class="cd-tag">agent</em>
              </span>
              <span class="cd-bubble cd-bubble--agent">{{ line.text }}</span>
            </template>

            <!-- tool call -->
            <span v-else-if="line.kind === 'tool'" class="cd-tool">
              <i aria-hidden="true">▸</i> {{ line.who }} called
              <code>{{ line.call }}</code>
            </span>

            <!-- system / membership event -->
            <span v-else class="cd-sys">{{ line.text }}</span>
          </div>
        </template>

        <div v-if="typing" class="cd-row cd-row--agent">
          <span class="cd-typing" aria-hidden="true"><i /><i /><i /></span>
        </div>
      </div>

      <div class="cd-composer" aria-hidden="true">
        <span class="cd-composer__field">Message #ask-ai<i class="cd-caret" /></span>
        <span class="cd-composer__send">Send</span>
      </div>
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
  min-height: clamp(360px, 46vw, 440px);
}
.cd-app__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1.05rem;
  border-bottom: 1px solid var(--sl-code-border);
  background: var(--sl-code-bg-2);
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

.cd-feed {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 1rem 1.05rem;
  overflow: hidden;
}
.cd-row {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  max-width: 82%;
}
.cd-row--self { align-self: flex-end; align-items: flex-end; }
.cd-row--tool,
.cd-row--sys { max-width: 100%; }

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
  color: var(--sl-code-text);
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

.cd-composer {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.7rem 0.85rem;
  border-top: 1px solid var(--sl-code-border);
  background: var(--sl-code-bg-2);
}
.cd-composer__field {
  flex: 1;
  display: inline-flex;
  align-items: center;
  padding: 0.5rem 0.7rem;
  border-radius: 9px;
  background: var(--sl-code-bg);
  border: 1px solid var(--sl-code-border);
  font-size: 0.82rem;
  color: var(--sl-code-dim);
}
.cd-caret {
  width: 1px;
  height: 0.95em;
  margin-left: 2px;
  background: var(--sl-cyan-bright);
}
.cd-composer__send {
  padding: 0.5rem 0.95rem;
  border-radius: 9px;
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--sl-on-cyan);
  background: var(--sl-cyan-bright);
}

/* ── motion ── */
@media (prefers-reduced-motion: no-preference) {
  .cd-row {
    animation: cd-in 0.42s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .cd-dot {
    animation: cd-pulse 2.2s ease-out infinite;
  }
  .cd-caret {
    animation: cd-blink 1.1s step-end infinite;
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
@keyframes cd-blink { 50% { opacity: 0; } }
@keyframes cd-think {
  0%, 100% { opacity: 0.35; transform: scale(0.82); }
  50% { opacity: 1; transform: scale(1); }
}

/* ── responsive: stack, code first then the app ── */
@media (max-width: 880px) {
  .cd {
    grid-template-columns: minmax(0, 1fr);
  }
  .cd-app { min-height: clamp(340px, 90vw, 420px); }
}
</style>
