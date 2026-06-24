import { useCallback, useState } from 'react'

export interface ReadState {
  /** channelId -> timestamp of the newest message the user has seen */
  lastRead: Record<string, number>
  /** mark a channel read up to `at` (no-op if already further along) */
  markRead: (channelId: string, at: number) => void
}

/**
 * Per-browser unread tracking. Read state lives in localStorage keyed by the user's name — it is
 * intentionally NOT synced across devices (that would need server-side per-user state; out of scope
 * for this example). Unread counts are derived client-side from the synced message Resources.
 */
export function useReadState(me: string): ReadState {
  const key = `slack:lastread:${me}`
  const [lastRead, setLastRead] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, number>
    } catch {
      return {}
    }
  })

  const markRead = useCallback(
    (channelId: string, at: number) => {
      setLastRead((prev) => {
        if ((prev[channelId] ?? 0) >= at) return prev
        const next = { ...prev, [channelId]: at }
        try {
          localStorage.setItem(key, JSON.stringify(next))
        } catch {
          /* ignore quota / private-mode errors */
        }
        return next
      })
    },
    [key],
  )

  return { lastRead, markRead }
}
