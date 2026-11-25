import { renderSVG } from 'uqr'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { peerClient, type PeerRoomMember } from '@super-line/plugin-peer/client'
import { contract, controls, wsUrl, type Config } from './contract.js'
import './styles.css'

const PALETTE = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']
const SPEED = 320
const RADIUS = 18
const STALE_STICK_MS = 200

interface Player {
  name: string
  color: string
  link: PeerRoomMember['link']
  x: number
  y: number
  stick: { x: number; y: number }
  stickAt: number
  rtt?: number
  pulse: number
  wall: boolean
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const canvas = $<HTMLCanvasElement>('arena')
const ctx2d = canvas.getContext('2d')!
const membersEl = $('members')
const roomStateEl = $('room-state')
const players = new Map<string, Player>()
let colorSeq = 0

async function main() {
  const config = (await fetch('/config.json').then((r) => r.json())) as Config
  const client = createSuperLineClient(contract, {
    transport: webSocketClientTransport({ url: wsUrl() }),
    role: 'screen',
    params: { role: 'screen', name: 'Screen' },
  })
  const peers = peerClient(client, controls, {
    iceServers: config.iceServers,
    onError: (error, info) => console.warn('peer', info.member?.id ?? '', error),
  })
  const room = await peers.createRoom({ accept: (joiner) => joiner.role === 'controller', maxMembers: 9 })
  const events = room.channel('events')

  const url = `${config.joinBase}/c#${room.key}`
  $('qr').innerHTML = renderSVG(url, { pixelSize: 6, border: 2 })
  const link = $<HTMLAnchorElement>('join-link')
  link.href = url
  link.textContent = url
  roomStateEl.textContent = 'open · waiting for controllers'

  const sendTo = (id: string, message: Parameters<typeof events.send>[0]) => {
    if (players.get(id)?.link !== 'open') return
    try {
      events.to(id).send(message)
    } catch {}
  }

  room.onMember(({ type, member }) => {
    if (type === 'left') players.delete(member.id)
    else {
      const player = players.get(member.id) ?? spawn(member)
      player.link = member.link
      if (type === 'link' && member.link === 'open') sendTo(member.id, { type: 'color', color: player.color })
    }
    renderMembers()
  })

  room.channel('stick').on((stick, from) => {
    const player = players.get(from.id)
    if (!player) return
    player.stick = stick
    player.stickAt = performance.now()
  })

  events.on((message, from) => {
    const player = players.get(from.id)
    if (message.type === 'ping') sendTo(from.id, { type: 'pong', t: message.t })
    else if (message.type === 'pong' && player) player.rtt = performance.now() - message.t
    else if (message.type === 'press' && player) {
      player.pulse = 1
      sendTo(from.id, { type: 'bump' })
    }
  })

  setInterval(() => {
    for (const id of players.keys()) sendTo(id, { type: 'ping', t: performance.now() })
    renderMembers()
  }, 500)

  let last = performance.now()
  const frame = (now: number) => {
    step(Math.min((now - last) / 1000, 0.05), (id) => sendTo(id, { type: 'bump' }))
    last = now
    draw()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

function spawn(member: PeerRoomMember): Player {
  const player: Player = {
    name: String(member.info?.name ?? 'Player'),
    color: PALETTE[colorSeq++ % PALETTE.length]!,
    link: member.link,
    x: canvas.width / 2 + (Math.random() - 0.5) * 200,
    y: canvas.height / 2 + (Math.random() - 0.5) * 200,
    stick: { x: 0, y: 0 },
    stickAt: 0,
    pulse: 0,
    wall: false,
  }
  players.set(member.id, player)
  return player
}

function step(dt: number, bump: (id: string) => void) {
  const now = performance.now()
  for (const [id, p] of players) {
    if (now - p.stickAt > STALE_STICK_MS) p.stick = { x: 0, y: 0 }
    p.pulse = Math.max(0, p.pulse - dt * 2)
    const x = p.x + p.stick.x * SPEED * dt
    const y = p.y + p.stick.y * SPEED * dt
    p.x = Math.min(Math.max(x, RADIUS), canvas.width - RADIUS)
    p.y = Math.min(Math.max(y, RADIUS), canvas.height - RADIUS)
    const wall = p.x !== x || p.y !== y
    if (wall && !p.wall) bump(id)
    p.wall = wall
  }
}

function draw() {
  const { width, height } = canvas.getBoundingClientRect()
  if (canvas.width !== Math.round(width) || canvas.height !== Math.round(height)) {
    canvas.width = Math.round(width)
    canvas.height = Math.round(height)
  }
  ctx2d.clearRect(0, 0, canvas.width, canvas.height)
  ctx2d.font = '13px ui-sans-serif, system-ui, sans-serif'
  ctx2d.textAlign = 'center'
  for (const p of players.values()) {
    if (p.link !== 'open') continue
    if (p.pulse > 0) {
      ctx2d.beginPath()
      ctx2d.arc(p.x, p.y, RADIUS + (1 - p.pulse) * 40, 0, Math.PI * 2)
      ctx2d.strokeStyle = p.color
      ctx2d.globalAlpha = p.pulse
      ctx2d.lineWidth = 4
      ctx2d.stroke()
      ctx2d.globalAlpha = 1
    }
    ctx2d.beginPath()
    ctx2d.arc(p.x, p.y, RADIUS, 0, Math.PI * 2)
    ctx2d.fillStyle = p.color
    ctx2d.fill()
    ctx2d.fillStyle = '#e2e8f0'
    ctx2d.fillText(p.rtt === undefined ? p.name : `${p.name} · ${p.rtt.toFixed(1)} ms`, p.x, p.y + RADIUS + 16)
  }
}

function renderMembers() {
  membersEl.replaceChildren(
    ...[...players.values()].map((p) => {
      const li = document.createElement('li')
      const swatch = document.createElement('span')
      swatch.className = 'swatch'
      swatch.style.background = p.color
      const label = document.createElement('span')
      label.textContent = p.name
      const meta = document.createElement('span')
      meta.className = `link link-${p.link}`
      meta.textContent = p.link === 'open' && p.rtt !== undefined ? `open · ${p.rtt.toFixed(1)} ms` : p.link
      li.append(swatch, label, meta)
      return li
    }),
  )
  roomStateEl.textContent = players.size ? `${players.size} controller${players.size === 1 ? '' : 's'}` : 'open · waiting for controllers'
}

main().catch((err) => {
  roomStateEl.textContent = `could not create a room: ${err instanceof Error ? err.message : String(err)}`
})
