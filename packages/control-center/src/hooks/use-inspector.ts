import { useEffect, useState } from 'react'
import { createInspector, type InspectorClient, type InspectorStatus } from '@/lib/inspector-client'

/** Connect to an inspector endpoint, re-connecting whenever `url` changes. */
export function useInspector(url: string): { client: InspectorClient | null; status: InspectorStatus } {
  const [client, setClient] = useState<InspectorClient | null>(null)
  const [status, setStatus] = useState<InspectorStatus>('connecting')

  useEffect(() => {
    if (!url) return
    const c = createInspector({ url })
    setClient(c)
    const off = c.onStatus(setStatus)
    return () => {
      off()
      c.close()
      setClient(null)
    }
  }, [url])

  return { client, status }
}
