<script setup lang="ts">
/* The shared chrome for every tutorial live demo: a dark instrument panel (same
   family as the home-page code windows), a status strip, a boot-failure fallback,
   and the standing "What's real here" caption every widget must carry. Purely
   presentational — each widget owns its own boot/teardown. */

defineProps<{
  /** Window-bar label, e.g. "tutorial 1 · a live server in this tab". */
  name: string
  status: 'booting' | 'live' | 'failed' | 'offline'
  /** The honesty caption: what is real, what is substituted in-tab. */
  real: string
  /** Optional override for the status strip's text. */
  statusText?: string
}>()

const STATUS_LABEL = { booting: 'booting…', live: 'live', failed: 'demo unavailable', offline: 'stopped' } as const
</script>

<template>
  <figure class="ds" :class="'is-' + status">
    <div class="ds-win" role="group" :aria-label="name">
      <div class="ds-bar">
        <span class="ds-dot" /><span class="ds-dot" /><span class="ds-dot" />
        <span class="ds-name">{{ name }}</span>
        <span class="ds-status">
          <i class="ds-pip" aria-hidden="true" />{{ statusText ?? STATUS_LABEL[status] }}
        </span>
      </div>

      <div v-if="status === 'failed'" class="ds-fallback">
        <p>The live demo couldn't start in this browser — the code on this page is the real wiring; run it locally instead.</p>
      </div>
      <div v-else class="ds-body">
        <slot />
      </div>
    </div>
    <figcaption class="ds-real"><b>What's real here:</b> {{ real }}</figcaption>
  </figure>
</template>

<style scoped>
.ds {
  margin: 24px 0;
}
.ds-win {
  border-radius: 14px;
  background: var(--sl-code-bg);
  border: 1px solid var(--sl-code-border);
  box-shadow: 0 20px 50px -28px rgba(2, 12, 20, 0.7), 0 2px 8px -4px rgba(2, 12, 20, 0.5);
  overflow: hidden;
}
:global(.dark) .ds-win {
  border-color: #2a3441;
}
.ds-bar {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.6rem 0.9rem;
  background: var(--sl-code-bg-2);
  border-bottom: 1px solid var(--sl-code-border);
}
.ds-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #2c3744;
}
.ds-dot:first-child {
  background: #3a4654;
}
.ds-name {
  margin-left: 0.4rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.74rem;
  color: var(--sl-code-dim);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ds-status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex: none;
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  color: var(--sl-code-dim);
}
.ds-pip {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #3a4654;
}
.is-live .ds-pip {
  background: var(--sl-cyan-bright);
}
.is-live .ds-status {
  color: var(--sl-cyan-strong);
}
.is-failed .ds-pip,
.is-offline .ds-pip {
  background: #d4634e;
}
@media (prefers-reduced-motion: no-preference) {
  .is-live .ds-pip {
    animation: ds-pulse 2.2s ease-out infinite;
  }
}
@keyframes ds-pulse {
  0% { box-shadow: 0 0 0 0 rgba(34, 211, 238, 0.45); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

.ds-body {
  display: flex;
  flex-direction: column;
}
.ds-fallback {
  padding: 1.4rem 1.2rem;
}
.ds-fallback p {
  margin: 0;
  font-size: 0.84rem;
  line-height: 1.55;
  color: var(--sl-code-dim);
  text-align: center;
}
.ds-real {
  margin: 0.55rem 0.2rem 0;
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--sl-text-2);
}
.ds-real b {
  color: var(--sl-text);
  font-weight: 600;
}

/* ── shared control vocabulary for the widgets inside (deep, opt-in classes) ── */
.ds :deep(.ds-btn) {
  appearance: none;
  font: 500 0.78rem/1 var(--vp-font-family-base);
  color: var(--sl-code-text);
  background: var(--sl-code-bg-2);
  border: 1px solid var(--sl-code-border);
  padding: 0.42rem 0.75rem;
  border-radius: 999px;
  cursor: pointer;
  transition: border-color 0.16s, background-color 0.16s, color 0.16s;
}
.ds :deep(.ds-btn:hover:not(:disabled)) {
  border-color: var(--sl-cyan);
  color: var(--sl-cyan-strong);
  background: color-mix(in oklab, var(--sl-cyan) 10%, var(--sl-code-bg-2));
}
.ds :deep(.ds-btn:focus-visible) {
  outline: 2px solid var(--sl-cyan-bright);
  outline-offset: 2px;
}
.ds :deep(.ds-btn:disabled) {
  opacity: 0.45;
  cursor: default;
}
.ds :deep(.ds-btn--primary) {
  border: 0;
  font-weight: 700;
  color: var(--sl-on-cyan);
  background: var(--sl-cyan-bright);
}
.ds :deep(.ds-btn--primary:hover:not(:disabled)) {
  color: var(--sl-on-cyan);
  background: var(--sl-cyan-bright);
  filter: brightness(1.08);
}
.ds :deep(.ds-field) {
  min-width: 0;
  padding: 0.5rem 0.65rem;
  border-radius: 9px;
  background: var(--sl-code-bg);
  border: 1px solid var(--sl-code-border);
  font: inherit;
  font-size: 0.82rem;
  color: var(--sl-code-text);
}
.ds :deep(.ds-field::placeholder) {
  color: var(--sl-code-dim);
}
.ds :deep(.ds-field:focus-visible) {
  outline: none;
  border-color: var(--sl-cyan);
}
.ds :deep(.ds-field:disabled) {
  opacity: 0.6;
}
</style>
