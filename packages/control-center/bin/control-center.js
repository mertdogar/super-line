#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('../dist', import.meta.url))

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  const value = i >= 0 ? process.argv[i + 1] : undefined
  return value ?? fallback
}

const target = arg('--url', 'ws://localhost:3000')
const port = Number(arg('--port', '7777'))
const noOpen = process.argv.includes('--no-open')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

if (!existsSync(join(root, 'index.html'))) {
  console.error('[control-center] built SPA missing — run `vite build` (the published package ships dist/).')
  process.exit(1)
}

const server = createServer(async (req, res) => {
  const reqUrl = new URL(req.url ?? '/', 'http://localhost')
  const path = decodeURIComponent(reqUrl.pathname)
  let file = normalize(join(root, path === '/' ? 'index.html' : path))
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden')
    return
  }
  if (!existsSync(file)) file = join(root, 'index.html') // SPA fallback for client routes
  try {
    // index.html: inject the launcher's --url as a default the app uses unless the user saved
    // their own (explicit ?url= wins over both). Avoids a forced redirect that would override a
    // saved connection. Any other path is served verbatim.
    if (file === join(root, 'index.html')) {
      const html = await readFile(file, 'utf8')
      const inject = `<script>window.__CC_DEFAULT_URL__=${JSON.stringify(target)}</script>`
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(html.replace('<head>', `<head>${inject}`))
      return
    }
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})

server.listen(port, () => {
  const href = `http://localhost:${port}/`
  console.log('\n  super-line · Control Center')
  console.log(`  inspecting   ${target}`)
  console.log(`  open         ${href}\n`)
  if (!noOpen) openBrowser(href)
})

function openBrowser(href) {
  const platform = process.platform
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', href] : [href]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // no browser — the URL is printed above
  }
}
