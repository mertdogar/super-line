import type { CDOpenFrame, ClientFrame, CSubFrame, EndFrame, ErrFrame, ResFrame, SubFrame } from '@super-line/core'

/** Subscribes replayed on adoption carry correlation ids from here up; clients count theirs up from 1 (ADR-0027). */
export const REPLAY_BASE = 2 ** 30

type LiveFrame = SubFrame | CSubFrame | CDOpenFrame

function keyOf(f: ClientFrame): string | undefined {
  if (f.t === 'sub' || f.t === 'unsub') return `t:${f.c}`
  if (f.t === 'csub' || f.t === 'cuns') return `c:${f.s}`
  if (f.t === 'cdopen' || f.t === 'cdclose') return `d:${f.n}:${f.id}`
  return undefined
}

/**
 * One connection's live subscribe set, as a connection snapshot records it (ADR-0027): a subscribe counts once
 * the server acknowledged it, an unsubscribe removes it, and a refused one never enters.
 */
export class SubscribeSet {
  private readonly live = new Map<string, LiveFrame>()
  private readonly pending = new Map<number, LiveFrame>() // awaiting the server's answer, by correlation id

  /** Seeded with a restored snapshot's frames, which its replays then confirm or refuse. */
  constructor(frames: LiveFrame[] = []) {
    for (const f of frames) this.live.set(keyOf(f)!, f)
  }

  /** An inbound frame. True when the live set changed. */
  inbound(frame: ClientFrame): boolean {
    const key = keyOf(frame)
    if (key === undefined) return false
    if (frame.t === 'sub' || frame.t === 'csub' || frame.t === 'cdopen') {
      this.pending.set(frame.i, frame)
      return false
    }
    for (const [i, f] of this.pending) if (keyOf(f) === key) this.pending.delete(i)
    return this.live.delete(key)
  }

  /** The server's answer to an inbound frame: the subscribe it settled, if it settled one. */
  settle(frame: ResFrame | ErrFrame): LiveFrame | undefined {
    if (frame.i === undefined) return undefined
    const sub = this.pending.get(frame.i)
    if (!sub) return undefined
    this.pending.delete(frame.i)
    const key = keyOf(sub)!
    if (frame.t === 'res' && !this.live.has(key)) this.live.set(key, sub)
    if (frame.t === 'err' && frame.i >= REPLAY_BASE) this.live.delete(key) // a replay the server now refuses
    return sub
  }

  frames(): LiveFrame[] {
    return [...this.live.values()]
  }
}

/** The `end` notice for a subscribe the server refused while re-establishing it. */
export function endOf(sub: LiveFrame, err: ErrFrame): EndFrame {
  if (sub.t === 'sub') return { t: 'end', kind: 'topic', c: sub.c, code: err.code, m: err.m }
  if (sub.t === 'csub') return { t: 'end', kind: 'collection', n: sub.n, s: sub.s, code: err.code, m: err.m }
  return { t: 'end', kind: 'doc', n: sub.n, id: sub.id, code: err.code, m: err.m }
}
