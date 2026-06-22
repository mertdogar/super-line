# @super-line/example-hono

[Hono](https://hono.dev) (via [`@hono/node-server`](https://github.com/honojs/node-server))
and super-line on **one process, one port**. Hono owns the HTTP routes and serves the
built frontend; super-line owns the WebSocket bus. They share the same Node `http.Server`.

Three live cards, each a different super-line wire pattern:

- **Server uptime** — a server-side `setInterval` publishes to the `uptime` **topic** every second.
- **Shared todos** — CRUD via **request/response**; every change is published to the `todos` topic. Also writable over HTTP (see the bridge below).
- **Shared cursors** — throttled `moveCursor` **requests**; the server tags each with identity from `ctx` and republishes the `cursors` topic.

## How the two halves compose

```ts
const app = new Hono()
const server = serve({ fetch: app.fetch, port })   // returns the Node http.Server
const srv = createSuperLineServer(demo, { server, path: '/ws' })  // attaches the 'upgrade' listener
```

A WebSocket upgrade fires Node's `'upgrade'` event, which **bypasses** Hono's `fetch`
handler — so Hono middleware runs on HTTP routes, while super-line's `authenticate`
is the auth hook for the WS handshake. The example shares one rule (`requireName`)
across **both** transports.

## REST → WS bridge

`POST /api/todos` writes a todo over HTTP and it appears live in every open tab:

```bash
curl -X POST http://localhost:3000/api/todos \
  -H 'content-type: application/json' \
  -H 'x-user-name: cli' \
  -d '{"text":"added from curl"}'
```

`GET /healthz` and `GET /api/todos` are plain Hono routes coexisting with the bus.

## Run

```bash
pnpm build   # vite build → dist/
pnpm start   # tsx src/server.ts → http://localhost:3000
# or: pnpm dev  (rebuilds the frontend on save, still one serving process)
```

Open `http://localhost:3000` in a few tabs and move your mouse around.
