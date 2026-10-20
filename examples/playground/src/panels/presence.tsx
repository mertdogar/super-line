import { useMemo, useState } from 'react'
import { useClient, useCollection, useEvent, useRequest } from '@super-line/react'
import { USER_PRESENCE_LIVE_MS } from '@super-line/plugin-auth'
import { useInterval, usePoll } from '../use-interval'

interface Nudge {
  from: string
  fromNode: string
  text: string
  at: number
}

export function PresencePanel(): React.JSX.Element {
  const { rows: users } = useCollection('users')
  // plugin-auth derives these rows from real connection sessions — live, and cluster-wide through Postgres.
  const { rows: presence } = useCollection('userPresence')
  const [now, setNow] = useState(Date.now())
  const online = useMemo(
    () =>
      new Set(presence.filter((p) => p.connectedAt !== null && (p.lastSeenAt ?? 0) > now - USER_PRESENCE_LIVE_MS).map((p) => p.userId)),
    [presence, now],
  )
  const names = useMemo(() => new Map(users.map((u) => [u.id, u.displayName])), [users])

  // srv.cluster.* reads the adapter's presence registry (Redis): every connection on every node.
  const client = useClient()
  const cluster = usePoll(() => client.cluster(), 2000)
  useInterval(() => setNow(Date.now()), 2000) // re-evaluate presence liveness

  const { call: nudge } = useRequest('nudge')
  const [nudges, setNudges] = useState<Nudge[]>([])
  useEvent('nudge', (n) => setNudges((prev) => [{ ...n, at: Date.now() }, ...prev].slice(0, 10)))

  return (
    <section className="panel">
      <h2>Presence</h2>
      <h3>Users · userPresence collection</h3>
      <ul className="plain">
        {users.map((u) => (
          <li key={u.id}>
            <span className={online.has(u.id) ? 'dot on' : 'dot'} /> {u.displayName}{' '}
            <button className="small" onClick={() => void nudge({ userId: u.id, text: '👋' })}>
              nudge
            </button>
          </li>
        ))}
      </ul>

      <h3>Cluster · srv.cluster.topology() + connections()</h3>
      {cluster?.nodes.map((n) => (
        <div key={n.nodeId} className="node-box">
          <b>{n.nodeName}</b>{' '}
          <span className="muted">
            {n.nodeId.slice(0, 8)} · {n.alive ? 'alive' : 'dead'} · {n.connections} conns
          </span>
          <ul className="plain">
            {cluster?.connections
              .filter((c) => c.nodeId === n.nodeId)
              .map((c) => (
                <li key={c.id} className="muted">
                  {c.userId ? (names.get(c.userId) ?? c.userId.slice(0, 6)) : 'guest'} · {c.role} · {c.transport ?? '?'} ·{' '}
                  {c.id.slice(0, 8)}
                </li>
              ))}
          </ul>
        </div>
      ))}

      <h3>Nudges received · srv.toUser(id).emit</h3>
      <ul className="plain log">
        {nudges.map((n) => (
          <li key={n.at}>
            {n.text} from <b>{n.from}</b> <span className="muted">via {n.fromNode}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
