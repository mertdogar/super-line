import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { demo, type Cursor, type Todo } from './contract.js'

const PORT = Number(process.env.PORT ?? 3000)
const PALETTE = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']

// The shared rule, applied at BOTH transports: a name must be present.
// WS rejects by throwing (→ 401 at upgrade); REST rejects with a 401 JSON below.
function requireName(raw: string | null | undefined): string {
  const name = raw?.trim()
  if (!name) throw new Error('name is required')
  return name
}

const app = new Hono()

// `serve()` returns the Node http.Server synchronously — hand it straight to
// super-line, which attaches its own 'upgrade' listener. One server, one port.
// `serve()` is typed as a union (http/http2); the default factory is a plain http.Server.
const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`hono + super-line listening on http://localhost:${PORT}`)
}) as Server

// In-memory runtime state (single process, default in-memory adapter).
const todos: Todo[] = []
const cursors = new Map<string, Cursor>()
let todoSeq = 0
let colorSeq = 0

const srv = createSuperLineServer(demo, {
  transports: [webSocketServerTransport({ server, path: '/ws' })],
  authenticate: (h) => {
    const name = requireName(h.query.name)
    const color = PALETTE[colorSeq++ % PALETTE.length]!
    return { role: 'user' as const, ctx: { id: randomUUID(), name, color } }
  },
  onConnection: (conn, ctx) => {
    // tell the tab who it is, so it can skip rendering its own cursor. Send straight to
    // the conn (we're on the node that owns it) — it hasn't joined its personal channel yet.
    conn.emit('welcome', { id: ctx.id, color: ctx.color })
  },
  onDisconnect: (_conn, ctx) => {
    if (cursors.delete(ctx.id)) publishCursors()
  },
})

const publishTodos = () => srv.publish('todos', { items: todos })
const publishCursors = () => srv.publish('cursors', { cursors: [...cursors.values()] })

const addTodo = (text: string, by: string): string => {
  const id = `t_${(todoSeq += 1)}`
  todos.push({ id, text, done: false, by })
  publishTodos()
  return id
}

srv.implement({
  shared: {
    getTodos: async () => ({ items: todos }),
    addTodo: async ({ text }, ctx) => ({ id: addTodo(text, ctx.name) }),
    toggleTodo: async ({ id }) => {
      const todo = todos.find((it) => it.id === id)
      if (todo) {
        todo.done = !todo.done
        publishTodos()
      }
      return { ok: Boolean(todo) }
    },
    editTodo: async ({ id, text }) => {
      const todo = todos.find((it) => it.id === id)
      if (todo) {
        todo.text = text
        publishTodos()
      }
      return { ok: Boolean(todo) }
    },
    removeTodo: async ({ id }) => {
      const i = todos.findIndex((it) => it.id === id)
      if (i >= 0) {
        todos.splice(i, 1)
        publishTodos()
      }
      return { ok: i >= 0 }
    },
    moveCursor: async ({ x, y }, ctx) => {
      cursors.set(ctx.id, { id: ctx.id, name: ctx.name, x, y, color: ctx.color })
      publishCursors()
      return { ok: true }
    },
  },
  user: {},
})

// Server-side uptime counter, pushed to every subscriber once a second.
const startedAt = Date.now()
setInterval(() => srv.publish('uptime', { seconds: Math.floor((Date.now() - startedAt) / 1000) }), 1000)

// --- Hono HTTP routes (run through Hono's middleware pipeline) ---
app.get('/healthz', (c) => c.json({ ok: true }))

app.get('/api/todos', (c) => c.json({ items: todos }))

// REST→WS bridge: `curl` a todo in, watch it appear live in every browser tab.
// Guarded by the SAME name rule the WS upgrade uses.
app.post('/api/todos', async (c) => {
  let name: string
  try {
    name = requireName(c.req.header('x-user-name'))
  } catch {
    return c.json({ error: 'x-user-name header is required' }, 401)
  }
  const body = (await c.req.json().catch(() => ({}))) as { text?: unknown }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) return c.json({ error: 'text is required' }, 400)
  return c.json({ id: addTodo(text, name) }, 201)
})

// Static frontend built by Vite into ./dist (served last so API routes win).
app.use('/*', serveStatic({ root: './dist' }))
