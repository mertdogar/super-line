import { useEffect, useRef, useState } from 'react'
import { createInspector, type InspectorClient, type InspectorStatus } from '@/lib/inspector-client'

/** Connect to an inspector endpoint, re-connecting whenever `url` changes or `nonce` is bumped (manual retry). */
export function useInspector(url: string, nonce = 0): { client: InspectorClient | null; status: InspectorStatus } {
  const [client, setClient] = useState<InspectorClient | null>(null)
  const [status, setStatus] = useState<InspectorStatus>('connecting')
  const failed = useRef(false)

  useEffect(() => {
    if (!url) return
    failed.current = false // a fresh target / manual retry gets a genuine "connecting" again
    setStatus('connecting')
    const c = createInspector({ url })
    setClient(c)
    // Once a connect attempt has failed, the client silently auto-retries — flapping connecting↔closed
    // every second. Report that as a steady 'closed' so the whole UI (header dot AND the empty state)
    // doesn't strobe; the first connect and an explicit retry still surface a real 'connecting'.
    const off = c.onStatus((s) => {
      if (s === 'closed') failed.current = true
      else if (s === 'open') failed.current = false
      setStatus(s === 'connecting' && failed.current ? 'closed' : s)
    })
    return () => {
      off()
      c.close()
      setClient(null)
    }
  }, [url, nonce])

  return { client, status }
}
