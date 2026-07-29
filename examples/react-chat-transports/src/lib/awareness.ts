import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import type { Doc as YDoc } from 'yjs'
import type { SuperLineClient } from '@super-line/client'
import type { chat } from '@/contract'

type Client = SuperLineClient<typeof chat, 'user'>

const toB64 = (u: Uint8Array): string => {
  let s = ''
  for (const byte of u) s += String.fromCharCode(byte)
  return btoa(s)
}
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/**
 * Carry Yjs **awareness** — who is in the document and what they have selected — over super-line.
 *
 * The document's content needs nothing like this: it is a CRDT, and the collection machinery already
 * replicates, gates and persists it. Awareness is the opposite kind of state in every respect. It is a
 * separate Yjs protocol that never rides a document update, so it would not cross the wire no matter how
 * well the document syncs; it is worthless a second after it is sent, so persisting it would be a bug
 * rather than a feature; and it must vanish when its author does, which is the one thing a durable
 * collection will not do for you. Hence a plain request-and-broadcast over a room.
 *
 * The echo is dropped here rather than at the server: every peer already knows its own Yjs client id, so
 * comparing against it costs nothing, whereas a server-side exclusion would mean tracking which
 * connection owns which id — state the server has no other reason to keep.
 */
export function bridgeAwareness(client: Client, channelId: string, doc: YDoc, user: { name: string; color: string }): {
  awareness: Awareness
  destroy: () => void
} {
  const awareness = new Awareness(doc)
  awareness.setLocalStateField('user', user)

  const publish = (changed: number[]): void => {
    const update = encodeAwarenessUpdate(awareness, changed)
    // Fire-and-forget: a dropped caret frame is self-healing — the next cursor move supersedes it, and
    // awareness re-announces on an interval anyway. Nothing here is worth surfacing an error for.
    void client.awarenessUpdate({ channelId, update: toB64(update) }).catch(() => {})
  }

  const onUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    publish([...added, ...updated, ...removed])
  }
  awareness.on('update', onUpdate)

  const sub = client.on('awareness', (payload) => {
    if (payload.channelId !== channelId) return
    // `applyAwarenessUpdate` is a no-op for our own client id, so the echo costs a decode and nothing more.
    applyAwarenessUpdate(awareness, fromB64(payload.update), 'super-line')
  })

  return {
    awareness,
    destroy: () => {
      sub()
      awareness.off('update', onUpdate)
      // Tell the room we are gone BEFORE tearing down: `destroy()` alone is silent, which is how a
      // closed tab leaves a caret behind that never blinks out.
      removeAwarenessStates(awareness, [doc.clientID], 'unmount')
      awareness.destroy()
    },
  }
}
