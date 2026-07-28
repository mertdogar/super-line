/**
 * The isolated-world half of the push path.
 *
 * The registry lives in the page's MAIN world, and a script there has no `chrome.runtime`. A content
 * script has `chrome.runtime` but cannot see the page's globals. So the two halves talk over
 * `window.postMessage`: the injected MAIN-world hook posts, this forwards.
 *
 * Push is an optimisation over polling, never a replacement: every record carries a sequence, the
 * panel ignores anything at or below its cursor, and a gap sends it back to the poll. If this relay is
 * never injected — the user declined the permission — nothing is lost, only latency.
 */

export const CHANNEL = 'super-line-devtools'

window.addEventListener('message', (event: MessageEvent<{ source?: string; record?: unknown }>) => {
  // only same-page messages from our own injected hook
  if (event.source !== window) return
  if (event.data?.source !== CHANNEL || !event.data.record) return
  // The service worker may be asleep or the port closed; the poll covers whatever this drops.
  void chrome.runtime.sendMessage({ type: 'record', record: event.data.record }).catch(() => {})
})
