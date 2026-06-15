# Examples

Runnable examples live in [`examples/`](https://github.com/mertdogar/super-line/tree/main/examples). Clone the repo and run `pnpm install` first.

## chat — roles in one room

A human (`user`) and an AI participant (`agent`) join the **same room** with different surfaces. Shows a `shared` `join` + `message` event, role-specific verbs (`say` vs `announce`), and `conn.role`.

```bash
pnpm --filter @super-line/example-chat start
```

Demonstrates: [roles](/guide/roles-auth), [shared requests](/guide/requests), [events & rooms](/guide/events-rooms).

## react-chat — browser app

A live React chat (Vite + a WS server). Open two browser tabs to chat in real time; shows the [React hooks](/guide/react), a presence [topic](/guide/topics), and a room broadcast.

```bash
pnpm --filter @super-line/example-react-chat dev   # http://localhost:5173
```

## auth — roles as an authorization boundary

Token auth with an `admin` and a `user` role. `whoami` is shared; `secret` is admin-only. A user calling `secret` gets `NOT_FOUND`; a bad token is rejected at the upgrade.

```bash
pnpm --filter @super-line/example-auth start
```

Demonstrates: [auth](/guide/roles-auth), [`NOT_FOUND` enforcement](/guide/roles-auth#enforcement-not-found), [errors](/guide/errors).

## scaling — multi-node fan-out

Boots **two nodes** against one Redis and proves a topic publish, a room broadcast, and a `serverToServer` event from node B all reach a client on node A. Needs Docker/Redis.

```bash
docker run --rm -p 6379:6379 redis:7
pnpm --filter @super-line/example-scaling start
```

Demonstrates: [scaling & adapters](/guide/scaling-adapters), [serverToServer](/guide/scaling-adapters#servertoserver-coordinate-the-cluster).
