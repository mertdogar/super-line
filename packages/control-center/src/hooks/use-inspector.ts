import { useEffect, useRef, useState } from 'react'
import { createInspector, type InspectorClient, type InspectorStatus } from '@/lib/inspector-client'

/** Credentials for a server running `inspector({ auth })`; blank for an unauthenticated inspector. */
export interface InspectorCredentials {
  user: string
  password: string
}

/**
 * Connect to an inspector endpoint, re-connecting whenever `url`, the credentials, or `nonce` change
 * (manual retry). `authReason` carries the server's explanation while `status` is `unauthorized`.
 */
export function useInspector(
  url: string,
  credentials: InspectorCredentials,
  nonce = 0,
): { client: InspectorClient | null; status: InspectorStatus; authReason?: string } {
  const [client, setClient] = useState<InspectorClient | null>(null)
  const [status, setStatus] = useState<InspectorStatus>('connecting')
  const [authReason, setAuthReason] = useState<string | undefined>(undefined)
  const failed = useRef(false)
  const { user, password } = credentials

  useEffect(() => {
    if (!url) return
    failed.current = false // a fresh target / manual retry gets a genuine "connecting" again
    setStatus('connecting')
    setAuthReason(undefined)
    const c = createInspector({ url, user, password })
    setClient(c)
    // Once a connect attempt has failed, the client silently auto-retries — flapping connecting↔closed
    // every second. Report that as a steady 'closed' so the whole UI (header dot AND the empty state)
    // doesn't strobe; the first connect and an explicit retry still surface a real 'connecting'.
    // `unauthorized` is exempt — it's terminal, so there are no retries to de-strobe.
    const off = c.onStatus((s, reason) => {
      if (s === 'closed') failed.current = true
      else if (s === 'open') failed.current = false
      setAuthReason(s === 'unauthorized' ? reason : undefined)
      setStatus(s === 'connecting' && failed.current ? 'closed' : s)
    })
    return () => {
      off()
      c.close()
      setClient(null)
    }
  }, [url, user, password, nonce])

  return { client, status, authReason }
}
