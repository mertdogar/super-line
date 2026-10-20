import { useEffect, useRef, useState } from 'react'

/** Runs `fn` every `ms`. */
export function useInterval(fn: () => void, ms: number): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const id = setInterval(() => ref.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}

/**
 * Fetches on mount, whenever `trigger` changes, and every `ms` (`null`: never on a timer), keeping the last
 * result on screen until the next one lands. Cluster topology and queue jobs have no client-readable live feed,
 * so these poll — and not through `useRequest().refetch`, which clears `data` while each call is in flight and
 * would blank the panel on every tick.
 */
export function usePoll<T>(fetch: () => Promise<T>, ms: number | null, trigger?: unknown): T | undefined {
  const [data, setData] = useState<T>()
  const ref = useRef(fetch)
  ref.current = fetch
  useEffect(() => {
    let live = true
    const tick = () =>
      void ref.current().then(
        (next) => live && setData(next),
        () => {},
      )
    tick()
    const id = ms === null ? undefined : setInterval(tick, ms)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [ms, trigger])
  return data
}
