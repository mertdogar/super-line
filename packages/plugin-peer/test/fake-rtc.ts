// An in-memory stand-in for RTCPeerConnection: two instances find each other through the opaque
// SDP strings the code under test relays, and connect once both sides hold each other's
// description and at least one candidate. It keeps the signaling states perfect negotiation
// relies on (including implicit rollback of a colliding offer) and pairs `negotiated` channels
// by id.

type Handler<E> = ((ev: E) => void) | null
type Data = string | ArrayBuffer

const later = (fn: () => void) => void setTimeout(fn, 0)
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const domError = (name: string, message: string) => Object.assign(new Error(message), { name })

export interface FakeNetwork {
  rtc(owner: string): typeof RTCPeerConnection
  connections(owner?: string): FakePeerConnection[]
  /** Never connect any pair between these two owners. */
  block(a: string, b: string): void
  unblock(a: string, b: string): void
  /** Inspect or rewrite every data-channel send; return `undefined` to drop it. */
  filter?: (owner: string, channelId: number, data: Data) => Data | undefined
}

export class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting'
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  onopen: Handler<Event> = null
  onmessage: Handler<MessageEvent<Data>> = null
  onclose: Handler<Event> = null
  peer: FakeDataChannel | undefined

  constructor(
    readonly owner: FakePeerConnection,
    readonly label: string,
    readonly id: number,
    readonly ordered: boolean,
    readonly maxRetransmits: number | null,
  ) {}

  send(data: string | ArrayBufferView): void {
    if (this.readyState !== 'open') throw domError('InvalidStateError', 'channel not open')
    const payload: Data =
      typeof data === 'string' ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer
    const size = typeof payload === 'string' ? new TextEncoder().encode(payload).byteLength : payload.byteLength
    if (size > this.owner.sctp!.maxMessageSize) throw new TypeError('message too large')
    const out = this.owner.net.filter ? this.owner.net.filter(this.owner.owner, this.id, payload) : payload
    if (out === undefined) return
    const peer = this.peer
    later(() => {
      if (peer?.readyState === 'open') peer.onmessage?.({ data: out } as MessageEvent<Data>)
    })
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    later(() => this.onclose?.(new Event('close')))
    this.peer?.remoteClosed()
  }

  remoteClosed(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    later(() => this.onclose?.(new Event('close')))
  }

  open(): void {
    this.readyState = 'open'
    later(() => this.onopen?.(new Event('open')))
  }
}

export class FakePeerConnection {
  static seq = 0
  readonly id = `pc${++FakePeerConnection.seq}`
  signalingState: RTCSignalingState = 'stable'
  connectionState: RTCPeerConnectionState = 'new'
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  sctp: { maxMessageSize: number } | null = null
  onnegotiationneeded: Handler<Event> = null
  onicecandidate: Handler<{ candidate: RTCIceCandidateInit | null }> = null
  onconnectionstatechange: Handler<Event> = null
  readonly channels = new Map<number, FakeDataChannel>()
  remote: FakePeerConnection | undefined
  gotCandidate = false
  closed = false
  private gen = 0

  constructor(
    readonly net: FakeNetwork & { blocked(a: string, b: string): boolean; all: FakePeerConnection[] },
    readonly owner: string,
    readonly config?: RTCConfiguration,
  ) {
    net.all.push(this)
  }

  createDataChannel(label: string, init: RTCDataChannelInit = {}): FakeDataChannel {
    if (!init.negotiated || init.id === undefined) throw new Error('the fake only supports negotiated channels')
    const dc = new FakeDataChannel(this, label, init.id, init.ordered ?? true, init.maxRetransmits ?? null)
    if (this.channels.size === 0) {
      later(() => {
        if (!this.closed && this.signalingState === 'stable' && !this.localDescription && !this.remoteDescription) {
          this.onnegotiationneeded?.(new Event('negotiationneeded'))
        }
      })
    }
    this.channels.set(init.id, dc)
    return dc
  }

  async setLocalDescription(): Promise<void> {
    await tick()
    if (this.closed) throw domError('InvalidStateError', 'closed')
    if (this.signalingState === 'stable') {
      this.localDescription = { type: 'offer', sdp: `fake offer ${this.id} ${++this.gen}` }
      this.signalingState = 'have-local-offer'
    } else if (this.signalingState === 'have-remote-offer') {
      this.localDescription = { type: 'answer', sdp: `fake answer ${this.id} ${++this.gen}` }
      this.signalingState = 'stable'
    } else throw domError('InvalidStateError', `setLocalDescription in ${this.signalingState}`)
    later(() => {
      if (this.closed) return
      this.onicecandidate?.({ candidate: { candidate: `candidate:${this.id}`, sdpMid: '0', sdpMLineIndex: 0 } })
      this.onicecandidate?.({ candidate: null })
    })
    this.tryConnect()
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await tick()
    if (this.closed) throw domError('InvalidStateError', 'closed')
    const remote = this.net.all.find((pc) => pc.id === desc.sdp?.split(' ')[2])
    if (!remote) throw domError('OperationError', 'unknown remote description')
    if (desc.type === 'offer') {
      if (this.signalingState === 'have-local-offer') {
        this.localDescription = null
        this.signalingState = 'stable'
      }
      if (this.signalingState !== 'stable') throw domError('InvalidStateError', `offer in ${this.signalingState}`)
      this.signalingState = 'have-remote-offer'
    } else if (desc.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') throw domError('InvalidStateError', `answer in ${this.signalingState}`)
      this.signalingState = 'stable'
    }
    this.remote = remote
    this.remoteDescription = desc
    this.tryConnect()
  }

  async addIceCandidate(init: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescription) throw domError('InvalidStateError', 'no remote description')
    if (!init.candidate) return
    if (init.candidate !== `candidate:${this.remote?.id}`) throw domError('OperationError', 'foreign candidate')
    this.gotCandidate = true
    this.tryConnect()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.signalingState = 'closed'
    this.connectionState = 'closed'
    for (const dc of this.channels.values()) {
      if (dc.readyState === 'closed') continue
      dc.readyState = 'closed'
      dc.peer?.remoteClosed()
    }
  }

  private ready(): boolean {
    return (
      !this.closed &&
      this.signalingState === 'stable' &&
      !!this.localDescription &&
      !!this.remoteDescription &&
      this.gotCandidate
    )
  }

  private tryConnect(): void {
    const remote = this.remote
    if (!remote || remote.remote !== this || this.connectionState === 'connected') return
    if (!this.ready() || !remote.ready() || this.net.blocked(this.owner, remote.owner)) return
    for (const pc of [this, remote]) {
      pc.connectionState = 'connected'
      pc.sctp = { maxMessageSize: 65_536 }
    }
    for (const [id, dc] of this.channels) {
      const other = remote.channels.get(id)
      if (!other) continue
      dc.peer = other
      other.peer = dc
      dc.open()
      other.open()
    }
    for (const pc of [this, remote]) later(() => pc.onconnectionstatechange?.(new Event('connectionstatechange')))
  }
}

export function createFakeNetwork(): FakeNetwork {
  const blocks = new Set<string>()
  const pair = (a: string, b: string) => [a, b].sort().join('\u0000')
  const net = {
    all: [] as FakePeerConnection[],
    blocked: (a: string, b: string) => blocks.has(pair(a, b)),
    block(a: string, b: string) {
      blocks.add(pair(a, b))
    },
    unblock(a: string, b: string) {
      blocks.delete(pair(a, b))
    },
    connections: (owner?: string) => net.all.filter((pc) => owner === undefined || pc.owner === owner),
    rtc(owner: string) {
      return class extends FakePeerConnection {
        constructor(config?: RTCConfiguration) {
          super(net, owner, config)
        }
      } as unknown as typeof RTCPeerConnection
    },
  } as FakeNetwork & { all: FakePeerConnection[]; blocked(a: string, b: string): boolean }
  return net
}
