import * as React from 'react'
import { isIn } from '@super-line/core'
import type { ConnDescriptor, InspectedContract, InspectorEnvelope } from '@super-line/core'
import type { InspectorClient } from '@/lib/inspector-client'
import {
  DIRECTORY_COLLECTION,
  EMPTY_DIRECTORY,
  authLensActive,
  rowToIdentity,
  userIdsOf,
  type Directory,
  type Identity,
} from '@/lib/identity'

/**
 * The auth user directory for the currently-connected users (the [[Identity lens]]).
 *
 * Fetches only the rows the connection list actually references — bounded by connections, not by directory
 * size — and keeps them live off the `collection.change` feed the Control Center is already subscribed to,
 * rather than polling or opening a second subscription seam. Inactive (and empty) when the server has no
 * auth plugin, in which case every consumer degrades to raw ids.
 */
export function useDirectory(
  client: InspectorClient | null,
  contract: InspectedContract | null,
  connections: ConnDescriptor[],
): Directory {
  const [directory, setDirectory] = React.useState<Map<string, Identity>>(new Map())
  const active = authLensActive(contract)

  // The set of ids to hold, as a stable string so an unchanged set doesn't re-trigger the fetch —
  // `connections` is a fresh array on every inspector event.
  const idKey = React.useMemo(() => userIdsOf(connections).sort().join(','), [connections])

  React.useEffect(() => {
    if (!client || !active) {
      setDirectory(new Map())
      return
    }
    const ids = idKey ? idKey.split(',') : []
    if (ids.length === 0) {
      setDirectory(new Map())
      return
    }
    let live = true
    client
      .queryCollection(DIRECTORY_COLLECTION, { filter: isIn('id', ids), limit: ids.length })
      .then((rows) => {
        if (!live) return
        const next = new Map<string, Identity>()
        for (const row of rows) {
          const identity = rowToIdentity(row)
          if (identity) next.set(identity.userId, identity)
        }
        setDirectory(next)
      })
      .catch(() => {
        /* directory unavailable (e.g. no collection store) — consumers fall back to raw ids */
      })
    return () => {
      live = false
    }
  }, [client, active, idKey])

  // A rename lands as a row change on the feed, carrying the whole next row — patch in place, no refetch.
  React.useEffect(() => {
    if (!client || !active) return
    return client.onEvent((env: InspectorEnvelope) => {
      const event = env.event
      if (event.type !== 'collection.change' || event.n !== DIRECTORY_COLLECTION) return
      setDirectory((prev) => {
        if (event.op === 'delete') {
          if (!prev.has(event.id)) return prev
          const next = new Map(prev)
          next.delete(event.id)
          return next
        }
        const identity = rowToIdentity(event.row)
        // only track users we're already holding — an unrelated signup shouldn't grow the map
        if (!identity || !prev.has(identity.userId)) return prev
        return new Map(prev).set(identity.userId, identity)
      })
    })
  }, [client, active])

  return active ? directory : EMPTY_DIRECTORY
}
