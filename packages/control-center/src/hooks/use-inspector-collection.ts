import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { CollectionQuery } from '@super-line/core'
import type { LiveRowSet } from '@super-line/client'
import type { InspectorClient } from '@/lib/inspector-client'

const EMPTY_ARRAY: any[] = []

export function useInspectorCollection<T = unknown>(
  client: InspectorClient | null,
  collection: string,
  query?: CollectionQuery
): { rows: T[], error?: unknown } {
  const queryKey = JSON.stringify(query ?? {})
  const [sub, setSub] = useState<LiveRowSet | null>(null)
  const [error, setError] = useState<unknown>()

  useEffect(() => {
    if (!client) {
      setSub(null)
      return
    }
    setError(undefined)
    const newSub = client.subscribeCollection(collection, JSON.parse(queryKey))
    setSub(newSub)
    newSub.ready.catch(setError)
    return () => {
      newSub.close()
    }
  }, [client, collection, queryKey])

  const subscribe = useCallback((onChange: () => void) => {
    if (!sub) return () => {}
    const off = sub.subscribe(onChange)
    let active = true
    sub.ready.then(() => { if (active) onChange() })
    return () => {
      active = false
      off()
    }
  }, [sub])

  const getRows = useCallback(() => (sub?.rows() as T[] | undefined) ?? EMPTY_ARRAY as T[], [sub])
  
  const rows = useSyncExternalStore(subscribe, getRows, () => EMPTY_ARRAY as T[])

  return { rows, error }
}
