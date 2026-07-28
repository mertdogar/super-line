import * as React from 'react'

const PREFIX = 'super-line-devtools:'

/**
 * State persisted to localStorage, so the panel opens the way you left it.
 *
 * localStorage rather than chrome.storage because it is synchronous: an async read would render one
 * frame at the default width and then jump, which is exactly the flash this avoids.
 */
export function useStored<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = React.useState<T>(() => {
    try {
      const raw = localStorage.getItem(PREFIX + key)
      return raw === null ? fallback : (JSON.parse(raw) as T)
    } catch {
      return fallback // corrupt or unavailable storage is not worth failing the panel over
    }
  })

  const set = React.useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(next))
      } catch {
        // quota or a private-mode restriction; the session still works, it just will not persist
      }
    },
    [key],
  )

  return [value, set]
}
