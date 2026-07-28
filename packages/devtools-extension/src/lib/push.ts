/**
 * Turning the push path on, from the panel.
 *
 * The extension installs with NO host permissions and no warnings, and polling works immediately.
 * This upgrades one origin at a time, on an explicit click — `chrome.permissions.request` requires a
 * user gesture, and a button handler in the panel is one.
 */

import type { ClientTapRecord } from '@super-line/core'
import { DEVTOOLS_GLOBAL } from '@super-line/plugin-devtools'
import { CHANNEL } from '../relay.js'
import { inspectedOriginPattern } from './bridge.js'

const PORT_NAME = 'super-line-devtools-panel'

/** Whether this origin has already been granted. */
export async function isGranted(): Promise<boolean> {
  const origin = await inspectedOriginPattern()
  if (!origin) return false
  return chrome.permissions.contains({ origins: [origin] })
}

/** Ask for the inspected origin. MUST be called from a click handler — the gesture is the requirement. */
export async function requestPush(): Promise<boolean> {
  const origin = await inspectedOriginPattern()
  if (!origin) return false
  return chrome.permissions.request({ origins: [origin] })
}

/** Give the permission back, so "off" is a real state rather than a disabled checkbox. */
export async function revokePush(): Promise<void> {
  const origin = await inspectedOriginPattern()
  if (origin) await chrome.permissions.remove({ origins: [origin] })
}

/**
 * The MAIN-world hook. Subscribes to the registry and posts each record to the isolated relay.
 *
 * Injected as a function rather than a file because it needs `world: 'MAIN'` to see the registry, and a
 * MAIN-world script has no `chrome.runtime` — hence the postMessage hop.
 */
function installHook(globalKey: string, channel: string): void {
  const w = globalThis as unknown as Record<string, unknown> & { __superLineDevtoolsPushed?: boolean }
  if (w.__superLineDevtoolsPushed) return // survive a re-injection
  const registry = w[globalKey] as
    | { __subscribe?(cb: (record: unknown) => void): () => void }
    | undefined
  if (!registry?.__subscribe) return
  w.__superLineDevtoolsPushed = true
  registry.__subscribe((record) => {
    window.postMessage({ source: channel, record }, '*')
  })
}

/** Inject both halves into the inspected tab. Safe to call again; the hook guards re-injection. */
export async function injectRelay(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['relay.js'] })
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: installHook,
    args: [DEVTOOLS_GLOBAL, CHANNEL],
  })
}

/**
 * Open the panel's port to the service worker. `onRecord` fires for pushed records; the caller still
 * reconciles them against its cursor, because push and poll can both deliver the same record.
 */
export function connectPushPort(tabId: number, onRecord: (record: ClientTapRecord) => void): () => void {
  const port = chrome.runtime.connect({ name: PORT_NAME })
  port.postMessage({ type: 'init', tabId })
  port.onMessage.addListener((msg: { type?: string; record?: ClientTapRecord }) => {
    if (msg.type === 'record' && msg.record) onRecord(msg.record)
  })
  return () => port.disconnect()
}
