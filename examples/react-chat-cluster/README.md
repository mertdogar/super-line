# react-chat-cluster — chat across two servers

The [`react-chat`](../react-chat) example is a single server. This one runs the **same chat
behind two server nodes**, so you can open the app in several browser tabs, watch each tab land
on a *different* server, and chat between them — every message crossing process boundaries via
the shared Redis adapter.

A single **Caddy** container serves the built React SPA *and* reverse-proxies the WebSocket,
`round_robin`-ing each connection across the nodes:

```
browser :8080 ── web (Caddy) ┬─ GET /    → the vite-built SPA
                             └─ WS  /ws  → round_robin → node-1 / node-2
                                                            │        │
                                                          redis  (shared adapter)
```

## Run it

```bash
cd examples/react-chat-cluster
docker compose up        # builds the images once, then boots redis + 2 nodes + web
```

Open <http://localhost:8080> in **two or more tabs** (same browser is fine). Pick a name in
each, join the same room.

## What you'll see

- **Each tab shows its node** in the header — `you are ada on node-1`, `you are grace on
  node-2`. `round_robin` puts the first two tabs on different servers.
- **Messages cross servers.** Type in the node-1 tab; it appears in the node-2 tab, tagged with
  its origin — `ada@node-1`. The send is a `room.broadcast` that the Redis adapter fans out to
  members on every node.
- **The online count is cluster-wide.** It comes from the adapter's presence directory
  (`srv.cluster.room(room).length`), so opening a third tab on either server ticks every tab to
  `3 online`.

> A tab is bound to its node for the life of its WebSocket. If the socket drops and reconnects
> it may land on the other node, and since the app joins the room only on mount (same as the
> single-node `react-chat`), it won't auto-rejoin — reload the tab to re-sync.
>
> The count is *eventually* consistent: the presence write is fire-and-forget, so two tabs
> joining on different nodes in the same instant may briefly show one fewer until the next
> join/leave nudges it.

## Stop

`Ctrl-C`, then `docker compose down`.

## How it maps to super-line

- `src/contract.ts` — `react-chat`'s contract plus `node` on the `message` payload and the
  `join` output, so the client can show where each socket and message live.
- `src/server.ts` — one node. `createRedisAdapter` is the only structural change from
  `react-chat`: it makes `room.broadcast` and the `presence` topic cross nodes. The per-node
  in-memory count is gone — presence is derived from `srv.cluster.room(room)`.
- `src/App.tsx` — `react-chat`'s UI, with the WS URL derived from `window.location`
  (same-origin, behind Caddy) and the node shown in the header and on each message.
- `Caddyfile` — serves `/srv` (the SPA) and `reverse_proxy`-es `/ws` across the nodes with
  `lb_policy round_robin`.
- `Dockerfile` / `Dockerfile.web` — the node image (tsx off source) and the SPA image
  (multi-stage `vite build` → Caddy).
