/**
 * The only code here that talks to Chrome. Deliberately thin: everything it returns feeds the pure
 * reducer, so this file has no logic worth testing and the reducer has all of it.
 *
 * `inspectedWindow.eval` runs in the inspected page's MAIN world — where the app's super-line client
 * and its devtools registry live — and needs NO permissions beyond `devtools_page`. That is what lets
 * the extension install with zero warnings and work immediately.
 */

import { DEVTOOLS_GLOBAL, type ClientStateSnapshot, type DrainBatch } from '@super-line/plugin-devtools'

/** Returned when the page has no registry: the app has not added `devtoolsPlugin()`, or has not loaded yet. */
export const NOT_INSTALLED = Symbol('not-installed')

function evaluate<T>(expression: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval<T>(expression, (result, exception) => {
      // A page mid-navigation, or one with no registry, is an ordinary state rather than an error —
      // the panel simply shows "waiting" and polls again.
      resolve(exception ? undefined : result)
    })
  })
}

/** Everything after `cursor`, or `NOT_INSTALLED` when the page has no registry. */
export async function drain(cursor: number, limit?: number): Promise<DrainBatch | typeof NOT_INSTALLED | undefined> {
  const args = limit === undefined ? `${cursor}` : `${cursor}, ${limit}`
  const out = await evaluate<DrainBatch | null>(
    `(globalThis.${DEVTOOLS_GLOBAL} ? globalThis.${DEVTOOLS_GLOBAL}.drain(${args}) : null)`,
  )
  if (out === undefined) return undefined
  return out === null ? NOT_INSTALLED : out
}

/** One client's current state — pulled only while an inspector is open. */
export async function inspectClient(clientId: string): Promise<ClientStateSnapshot | undefined> {
  const out = await evaluate<ClientStateSnapshot | null>(
    `(globalThis.${DEVTOOLS_GLOBAL} ? globalThis.${DEVTOOLS_GLOBAL}.inspect(${JSON.stringify(clientId)}) ?? null : null)`,
  )
  return out ?? undefined
}

/**
 * Plaintext contents of one open CRDT document. The wire carries only opaque deltas, so this is the
 * only way to see them — and it is a separate call precisely so hot documents are not serialized
 * on every poll for a reader who is not looking at them.
 */
export async function docSnapshot(clientId: string, n: string, id: string): Promise<unknown> {
  const args = [clientId, n, id].map((a) => JSON.stringify(a)).join(', ')
  return evaluate(
    `(globalThis.${DEVTOOLS_GLOBAL} ? globalThis.${DEVTOOLS_GLOBAL}.docSnapshot(${args}) ?? null : null)`,
  )
}

/** The origin pattern covering the inspected page, for a per-origin permission request. */
export async function inspectedOriginPattern(): Promise<string | undefined> {
  const href = await evaluate<string>('location.href')
  if (!href) return undefined
  try {
    const url = new URL(href)
    if (!url.protocol.startsWith('http')) return undefined
    // Match patterns ignore the port unless one is stated, so this covers every dev port on the host.
    return `${url.protocol}//${url.hostname}/*`
  } catch {
    return undefined
  }
}
