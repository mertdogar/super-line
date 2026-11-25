import { createSuperLineClient } from '@super-line/client'
import { SuperLineError } from '@super-line/core'
import { peerClient, type PeerCloseReason, type PeerRoom } from '@super-line/plugin-peer/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { contract, controls, wsUrl, type Config } from './contract.js'
import './styles.css'

type Room = PeerRoom<typeof controls.channels>

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const gate = $<HTMLFormElement>('gate')
const nameInput = $<HTMLInputElement>('name')
const padView = $('pad-view')
const pad = $('pad')
const knob = $('knob')
const again = $<HTMLButtonElement>('again')
const roomStateEl = $('room-state')
const linkStateEl = $('link-state')
const rttEl = $('rtt')
const wakeEl = $('wake')

const key = location.hash.slice(1)
const stick = { x: 0, y: 0 }
let wake: WakeLockSentinel | undefined
let closedReason: PeerCloseReason | undefined
let rtt: number | undefined

const stored = (() => {
  try {
    return localStorage.getItem('peer-controller:name') ?? ''
  } catch {
    return ''
  }
})()

if (!key) $('no-key').hidden = false
else if (stored) start(stored)
else {
  gate.hidden = false
  nameInput.focus()
  gate.addEventListener('submit', (e) => {
    e.preventDefault()
    const name = nameInput.value.trim()
    if (!name) return
    try {
      localStorage.setItem('peer-controller:name', name)
    } catch {}
    start(name)
  })
}

async function start(name: string) {
  gate.hidden = true
  padView.hidden = false
  again.addEventListener('click', () => location.reload())

  const config = (await fetch('/config.json').then((r) => r.json())) as Config
  const client = createSuperLineClient(contract, {
    transport: webSocketClientTransport({ url: wsUrl() }),
    role: 'controller',
    params: { role: 'controller', name },
    reconnectMaxMs: 3000,
    keepalive: 5000,
  })
  const peers = peerClient(client, controls, {
    iceServers: config.iceServers,
    onError: (error, info) => console.warn('peer', info.member?.id ?? '', error),
  })

  let room: Room
  try {
    room = await peers.join(key)
  } catch (err) {
    roomStateEl.textContent = `join failed: ${err instanceof SuperLineError ? err.code : String(err)}`
    again.hidden = false
    return
  }

  const screen = () => room.members.find((m) => m.role === 'screen')
  const events = room.channel('events')
  const toScreen = (send: (id: string) => void) => {
    const s = screen()
    if (s?.link !== 'open') return
    try {
      send(s.id)
    } catch {}
  }

  const render = () => {
    const s = screen()
    roomStateEl.textContent = closedReason ? `closed · ${closedReason}` : room.state
    linkStateEl.textContent = s?.link ?? '—'
    rttEl.textContent = rtt === undefined || s?.link !== 'open' ? '—' : `${rtt.toFixed(1)} ms`
    wakeEl.textContent = !('wakeLock' in navigator) ? 'unavailable here' : wake ? 'held' : 'released'
    document.body.dataset.linked = String(s?.link === 'open')
    again.hidden = !closedReason && s?.link !== 'failed'
  }

  const holdWake = async () => {
    if (wake || !('wakeLock' in navigator) || document.visibilityState !== 'visible' || screen()?.link !== 'open') return
    try {
      wake = await navigator.wakeLock.request('screen')
      wake.addEventListener('release', () => {
        wake = undefined
        render()
      })
    } catch {}
    render()
  }

  room.onState(render)
  room.onMember(() => {
    render()
    if (screen()?.link === 'open') void holdWake()
  })
  room.onClose((reason) => {
    closedReason = reason
    void wake?.release()
    render()
  })
  document.addEventListener('visibilitychange', () => void holdWake())

  events.on((message) => {
    if (message.type === 'color') document.body.style.setProperty('--accent', message.color)
    else if (message.type === 'ping') toScreen((id) => events.to(id).send({ type: 'pong', t: message.t }))
    else if (message.type === 'pong') rtt = performance.now() - message.t
    else if (message.type === 'bump') {
      if ('vibrate' in navigator) navigator.vibrate(40)
      document.body.classList.remove('bump')
      void document.body.offsetWidth
      document.body.classList.add('bump')
    }
  })

  $('button-a').addEventListener('pointerdown', () => toScreen((id) => events.to(id).send({ type: 'press', button: 'a' })))

  const input = room.channel('stick')
  const frame = () => {
    if (room.state === 'closed') return
    toScreen((id) => input.to(id).send(stick))
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  setInterval(() => {
    toScreen((id) => events.to(id).send({ type: 'ping', t: performance.now() }))
    render()
  }, 1000)

  render()
  void holdWake()
}

const move = (e: PointerEvent) => {
  const r = pad.getBoundingClientRect()
  const half = r.width / 2
  let x = (e.clientX - r.left - half) / half
  let y = (e.clientY - r.top - half) / half
  const length = Math.hypot(x, y)
  if (length > 1) {
    x /= length
    y /= length
  }
  stick.x = x
  stick.y = y
  knob.style.transform = `translate(${x * half * 0.7}px, ${y * half * 0.7}px)`
}

const release = () => {
  stick.x = stick.y = 0
  knob.style.transform = ''
}

pad.addEventListener('pointerdown', (e) => {
  pad.setPointerCapture(e.pointerId)
  move(e)
})
pad.addEventListener('pointermove', (e) => {
  if (pad.hasPointerCapture(e.pointerId)) move(e)
})
pad.addEventListener('pointerup', release)
pad.addEventListener('pointercancel', release)
