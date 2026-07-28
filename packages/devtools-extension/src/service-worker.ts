/**
 * Routes pushed records from a tab's relay to that tab's open DevTools panel.
 *
 * A DevTools page exists per inspected tab and dies when DevTools closes, so the panel announces its
 * tab id when it connects and the worker keeps the mapping only while the port is alive.
 */

const panels = new Map<number, chrome.runtime.Port>()

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'super-line-devtools-panel') return
  let tabId: number | undefined

  port.onMessage.addListener((msg: { type?: string; tabId?: number }) => {
    if (msg.type === 'init' && typeof msg.tabId === 'number') {
      tabId = msg.tabId
      panels.set(tabId, port)
    }
  })

  port.onDisconnect.addListener(() => {
    if (tabId !== undefined && panels.get(tabId) === port) panels.delete(tabId)
  })
})

chrome.runtime.onMessage.addListener((msg: { type?: string; record?: unknown }, sender) => {
  if (msg.type !== 'record') return
  const tabId = sender.tab?.id
  if (tabId === undefined) return
  const port = panels.get(tabId)
  // No panel open for this tab is the normal case, not an error — the relay outlives the panel.
  if (port) port.postMessage({ type: 'record', record: msg.record })
})
