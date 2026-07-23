import type { InspectedContract, InspectedPlugin } from '@super-line/core'

/**
 * Which plugin contributed a given contract entry (ADR-0016). A flat `key → plugin name` map: entries the
 * host declared itself are simply absent. Keys are namespaced by where the entry lives, because the same
 * name can appear in `shared` and in a role block.
 */
export type OwnerIndex = ReadonlyMap<string, string>

export type Direction = 'clientToServer' | 'serverToClient'

const collectionKey = (name: string): string => `c:${name}`
const sharedKey = (dir: Direction, name: string): string => `s:${dir}:${name}`
const roleKey = (role: string, dir: Direction, name: string): string => `r:${role}:${dir}:${name}`

export function buildOwnerIndex(plugins: readonly InspectedPlugin[] | undefined): OwnerIndex {
  const index = new Map<string, string>()
  for (const plugin of plugins ?? []) {
    const c = plugin.contract
    if (!c) continue // runtime-only plugin contributes no contract entries
    for (const name of c.collections) index.set(collectionKey(name), plugin.name)
    for (const dir of ['clientToServer', 'serverToClient'] as const) {
      for (const name of c.shared?.[dir] ?? []) index.set(sharedKey(dir, name), plugin.name)
      for (const [role, block] of Object.entries(c.roles ?? {})) {
        for (const name of block[dir]) index.set(roleKey(role, dir, name), plugin.name)
      }
    }
  }
  return index
}

/** The plugin owning a collection, or undefined when the host declared it. */
export function ownerOfCollection(index: OwnerIndex, name: string): string | undefined {
  return index.get(collectionKey(name))
}

/** The plugin owning a message, or undefined when the host declared it. `role` undefined = the shared block. */
export function ownerOfMessage(
  index: OwnerIndex,
  role: string | undefined,
  dir: Direction,
  name: string,
): string | undefined {
  return index.get(role === undefined ? sharedKey(dir, name) : roleKey(role, dir, name))
}

/** Headline counts for the Plugins page: what this plugin put on the contract. */
export function contributionCounts(plugin: InspectedPlugin): { collections: number; messages: number } {
  const c = plugin.contract
  if (!c) return { collections: 0, messages: 0 }
  const blocks = [c.shared, ...Object.values(c.roles ?? {})]
  const messages = blocks.reduce((n, b) => n + (b?.clientToServer.length ?? 0) + (b?.serverToClient.length ?? 0), 0)
  return { collections: c.collections.length, messages }
}

/** True when the server reported plugins at all (older nodes omit the field entirely). */
export function hasPluginInfo(contract: InspectedContract | null): boolean {
  return !!contract?.plugins
}
