import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSuperLineServer } from '@super-line/server'
import { peer } from '@super-line/plugin-peer/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { contract, type Config, type Role } from './contract.js'

const PORT = Number(process.env.PORT ?? 3000)
const DIST = fileURLToPath(new URL('../dist', import.meta.url))
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const lanAddress = () =>
  Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? 'localhost'

const config: Config = {
  joinBase: process.env.PUBLIC_URL ?? `http://${lanAddress()}:${PORT}`,
  iceServers: process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : [{ urls: 'stun:stun.l.google.com:19302' }],
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (pathname === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(config))
    return
  }
  const page = pathname === '/' ? 'index.html' : pathname === '/c' || pathname === '/c/' ? 'c/index.html' : pathname
  const file = normalize(join(DIST, page))
  if (!file.startsWith(DIST + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found')
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
})

createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server, path: '/ws' })],
  authenticate: (h) => ({
    role: (h.query.role === 'screen' ? 'screen' : 'controller') as Role,
    ctx: { name: (h.query.name ?? '').trim().slice(0, 24) || 'Player' },
  }),
  plugins: [
    peer<{ name: string }>({
      authorizeCreate: ({ creator }) => creator.role === 'screen',
      authorize: ({ ctx }) => ({ info: { name: ctx.name } }),
    }).plugin,
  ],
})

server.listen(PORT, () => {
  console.log(`screen:     http://localhost:${PORT}`)
  console.log(`controllers join at ${config.joinBase}/c#<room key> (the screen shows the QR code)`)
})
