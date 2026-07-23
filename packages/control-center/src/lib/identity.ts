import type { ConnDescriptor, InspectedContract } from '@super-line/core'

/**
 * The Control Center's presentation of `@super-line/plugin-auth`: how to read a user directory row. This
 * mapping is the observer's editorial opinion, held here rather than exported by the plugin — the plugin
 * grows no API surface to serve a debug UI. If the plugin renames a field, the lens degrades to raw ids.
 */
export const AUTH_PLUGIN = 'auth'
export const DIRECTORY_COLLECTION = 'users'
const LABEL_FIELD = 'displayName'
const ROLES_FIELD = 'roles'
const METADATA_FIELD = 'metadata'
const DELETED_FIELD = 'deletedAt'
const CREATED_FIELD = 'createdAt'

/** One directory row, as much of it as the CC understands. */
export interface Identity {
  userId: string
  displayName?: string
  roles?: string[]
  metadata?: Record<string, unknown>
  createdAt?: number
  /** Soft-delete: the user is deactivated but their rows still render. */
  deletedAt?: number
}

export type Directory = ReadonlyMap<string, Identity>

export const EMPTY_DIRECTORY: Directory = new Map()

/**
 * Whether this server has an auth user directory to join against — the auth plugin is registered AND its
 * fragment declares the directory collection. Both halves matter: a merged fragment whose server half is
 * missing has a `users` collection nobody writes.
 */
export function authLensActive(contract: InspectedContract | null): boolean {
  const auth = contract?.plugins?.find((p) => p.name === AUTH_PLUGIN)
  return !!auth?.runtime && !!auth.contract?.collections.includes(DIRECTORY_COLLECTION)
}

/** Read a directory row off the wire. Every field is optional — rows pass through redaction and snapshotting. */
export function rowToIdentity(row: unknown): Identity | null {
  if (typeof row !== 'object' || row === null) return null
  const r = row as Record<string, unknown>
  const userId = r.id
  if (typeof userId !== 'string') return null
  const roles = r[ROLES_FIELD]
  const metadata = r[METADATA_FIELD]
  return {
    userId,
    ...(typeof r[LABEL_FIELD] === 'string' ? { displayName: r[LABEL_FIELD] as string } : {}),
    ...(Array.isArray(roles) ? { roles: roles.filter((x): x is string => typeof x === 'string') } : {}),
    ...(typeof metadata === 'object' && metadata !== null ? { metadata: metadata as Record<string, unknown> } : {}),
    ...(typeof r[CREATED_FIELD] === 'number' ? { createdAt: r[CREATED_FIELD] as number } : {}),
    ...(typeof r[DELETED_FIELD] === 'number' ? { deletedAt: r[DELETED_FIELD] as number } : {}),
  }
}

/** The distinct user keys across the given connections — the exact set of directory rows worth fetching. */
export function userIdsOf(connections: readonly ConnDescriptor[]): string[] {
  const ids = new Set<string>()
  for (const c of connections) if (c.userId) ids.add(c.userId)
  return [...ids]
}

/** A connection's display label, degrading through directory row → raw user key → nothing. */
export function displayNameOf(directory: Directory, userId: string | undefined): string | undefined {
  return userId ? directory.get(userId)?.displayName : undefined
}

/** Short form of an id for dense UI (topology nodes, table cells). */
export function shortId(id: string): string {
  return id.slice(0, 8)
}

/**
 * The two lines of a connection node: who, then which connection. Falls back to the role when there is no
 * identity to show, so a server without the auth plugin renders exactly as it did before the lens existed.
 */
export function connLabel(
  conn: { id: string; role: string; userId?: string },
  directory: Directory,
): { title: string; subtitle: string } {
  const name = displayNameOf(directory, conn.userId)
  if (name) return { title: name, subtitle: `${conn.role} · ${shortId(conn.id)}` }
  if (conn.userId) return { title: conn.role, subtitle: shortId(conn.userId) }
  return { title: conn.role, subtitle: shortId(conn.id) }
}

/** Connected identities with their connection counts, for the topology lens. Named users sort before anonymous. */
export function connectedUsers(
  connections: readonly ConnDescriptor[],
  directory: Directory,
): { userId: string; label: string; named: boolean; count: number }[] {
  const counts = new Map<string, number>()
  for (const c of connections) if (c.userId) counts.set(c.userId, (counts.get(c.userId) ?? 0) + 1)
  return [...counts.entries()]
    .map(([userId, count]) => {
      const name = displayNameOf(directory, userId)
      return { userId, label: name ?? shortId(userId), named: !!name, count }
    })
    .sort((a, b) => (a.named !== b.named ? (a.named ? -1 : 1) : a.label.localeCompare(b.label)))
}
