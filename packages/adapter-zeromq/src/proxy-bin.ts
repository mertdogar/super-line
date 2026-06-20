#!/usr/bin/env node
import { createZeroMqProxy } from './index.js'

const frontendUrl = process.env.ZMQ_PROXY_FRONTEND ?? process.argv[2] ?? 'tcp://0.0.0.0:5557'
const backendUrl = process.env.ZMQ_PROXY_BACKEND ?? process.argv[3] ?? 'tcp://0.0.0.0:5558'

const proxy = await createZeroMqProxy({ frontendUrl, backendUrl })
console.log(`[super-line/zeromq-proxy] PUB in ${proxy.frontendUrl} -> SUB out ${proxy.backendUrl}`)

const shutdown = (): void => void proxy.stop().then(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
