import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { dashboard } from './dashboard-contract.js'

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'

export const client = createSuperLineClient(dashboard, {
  transport: webSocketClientTransport({ url: `${protocol}//${window.location.host}/ws` }),
  role: 'dashboard',
  validate: 'inbound',
})
