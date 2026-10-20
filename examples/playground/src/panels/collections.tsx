import { useMemo, useRef, useState } from 'react'
import { avg, coalesce, count, createCollection, eq as is } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { superLineCollectionOptions } from '@super-line/tanstack-db'
import { andFilters, eq, gte, ilike, isIn, type CollectionName, type CollectionQuery } from '@super-line/core'
import { useAuth } from '@super-line/plugin-auth/react'
import { useClient } from '@super-line/react'
import { app, type Task } from '../contract'
import { useDebounced } from '../use-interval'

type Status = Task['status']
const STATUSES: Status[] = ['todo', 'doing', 'done']
const NEXT: Record<Status, Status> = { todo: 'doing', doing: 'done', done: 'todo' }

interface Filter {
  projectId: string
  statuses: Status[]
  minPriority: number
  text: string
  mine: boolean
}

/** The tab's filter as a super-line query IR: this is what the server evaluates, and all that crosses the wire. */
function toQuery(f: Filter, me: string): CollectionQuery {
  const filter = andFilters(
    f.projectId ? eq('projectId', f.projectId) : undefined,
    f.statuses.length < STATUSES.length ? isIn('status', f.statuses) : undefined,
    f.minPriority > 1 ? gte('priority', f.minPriority) : undefined,
    f.text ? ilike('title', `%${f.text}%`) : undefined,
    f.mine ? eq('assigneeId', me) : undefined,
  )
  return filter ? { filter } : {}
}

type Client = ReturnType<typeof useClient>

/**
 * A TanStack DB collection fed by a super-line subscription. The adapter syncs ONE fixed IR query, so a new filter
 * is a new collection; the old one drops its server subscription once nothing reads it (`gcTime`).
 */
function synced<N extends CollectionName<typeof app>>(client: Client, name: N, query: CollectionQuery = {}) {
  return createCollection({ ...superLineCollectionOptions(client, app, name, { query }), gcTime: 2_000 })
}

/** Keeps the last ready result on screen while a re-created collection loads, instead of flashing empty. */
function useSteady<T>(data: T, ready: boolean): T {
  const last = useRef(data)
  if (ready) last.current = data
  return last.current
}

export function CollectionsPanel(): React.JSX.Element {
  const client = useClient()
  const me = useAuth().state.userId!
  const [f, setF] = useState<Filter>({ projectId: '', statuses: STATUSES, minPriority: 1, text: '', mine: false })
  const text = useDebounced(f.text, 300)
  const query = useMemo(() => toQuery({ ...f, text }, me), [f.projectId, f.statuses, f.minPriority, f.mine, text, me])
  const queryKey = JSON.stringify(query)

  // users (plugin-auth), projects and comments sync whole; tasks sync only the rows matching the IR.
  const users = useMemo(() => synced(client, 'users'), [client])
  const projects = useMemo(() => synced(client, 'projects'), [client])
  const comments = useMemo(() => synced(client, 'comments'), [client])
  const tasks = useMemo(() => synced(client, 'tasks', query), [client, queryKey])

  // ── everything below runs in the browser, over the synced rows, and updates incrementally ──

  // tasks ⋈ projects ⟕ users ⟕ (comments grouped by task)
  const board = useLiveQuery(
    (q) => {
      const counts = q
        .from({ c: comments })
        .groupBy(({ c }) => c.taskId)
        .select(({ c }) => ({ taskId: c.taskId, n: count(c.id) }))
      return q
        .from({ t: tasks })
        .join({ p: projects }, ({ t, p }) => is(t.projectId, p.id), 'inner')
        .join({ u: users }, ({ t, u }) => is(t.assigneeId, u.id), 'left')
        .join({ k: counts }, ({ t, k }) => is(t.id, k.taskId), 'left')
        .orderBy(({ t }) => t.priority, 'desc')
        .orderBy(({ t }) => t.createdAt, 'asc')
        .select(({ t, p, u, k }) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          project: p.name,
          assignee: u.displayName,
          comments: coalesce(k.n, 0),
        }))
    },
    [tasks, projects, users, comments],
  )
  const rows = useSteady(board.data, board.isReady)

  // projects ⟕ tasks, grouped: a project whose tasks are all filtered out still shows, with 0
  const summary = useLiveQuery(
    (q) =>
      q
        .from({ p: projects })
        .join({ t: tasks }, ({ p, t }) => is(t.projectId, p.id), 'left')
        .groupBy(({ p }) => [p.id, p.name])
        .select(({ p, t }) => ({ id: p.id, name: p.name, tasks: count(t.id), avgPriority: avg(t.priority) })),
    [projects, tasks],
  )
  const perProject = useSteady(summary.data, summary.isReady)

  const { data: people = [] } = useLiveQuery((q) => q.from({ u: users }).orderBy(({ u }) => u.displayName), [users])
  const { data: projectList = [] } = useLiveQuery((q) => q.from({ p: projects }).orderBy(({ p }) => p.name), [projects])

  const [selected, setSelected] = useState<string | null>(null)
  // comments ⟕ users, narrowed in the browser with a TanStack `where` — no new subscription
  const { data: thread = [] } = useLiveQuery(
    (q) =>
      selected
        ? q
            .from({ c: comments })
            .where(({ c }) => is(c.taskId, selected))
            .join({ u: users }, ({ c, u }) => is(c.authorId, u.id), 'left')
            .orderBy(({ c }) => c.createdAt)
            .select(({ c, u }) => ({ id: c.id, text: c.text, authorId: c.authorId, author: u.displayName }))
        : undefined,
    [comments, users, selected],
  )
  const selectedTask = rows.find((r) => r.id === selected)

  // Every write is optimistic: it shows at once, then the server's ack keeps it or its refusal rolls it back.
  const [error, setError] = useState<string | null>(null)
  const track = (tx: { isPersisted: { promise: Promise<unknown> } }) => {
    setError(null)
    tx.isPersisted.promise.catch((err: Error) => setError(err.message))
  }

  const [draft, setDraft] = useState({ title: '', projectId: 'web', priority: 2, assigneeId: '' })
  const [comment, setComment] = useState('')
  const toggleStatus = (s: Status) =>
    setF({ ...f, statuses: f.statuses.includes(s) ? f.statuses.filter((x) => x !== s) : STATUSES.filter((x) => x === s || f.statuses.includes(x)) })

  return (
    <section className="panel wide">
      <h2>Collections · TanStack DB over super-line</h2>
      <div className="split">
        <div>
          <h3>1 · Server · query IR → what crosses the wire</h3>
          <div className="stack">
            <div className="row">
              <select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
                <option value="">any project</option>
                {projectList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select value={f.minPriority} onChange={(e) => setF({ ...f, minPriority: Number(e.target.value) })}>
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    priority ≥ {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              {STATUSES.map((s) => (
                <label key={s}>
                  <input type="checkbox" checked={f.statuses.includes(s)} onChange={() => toggleStatus(s)} /> {s}
                </label>
              ))}
              <label>
                <input type="checkbox" checked={f.mine} onChange={(e) => setF({ ...f, mine: e.target.checked })} /> assigned to me
              </label>
            </div>
            <input placeholder="title contains…" value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
          </div>
          <p className="muted">
            <code>superLineCollectionOptions(client, app, 'tasks', {'{ query }'})</code> — the server pushes this down to SQL, re-checks it
            on every change, and sends only matching rows:
          </p>
          <pre>{JSON.stringify(query, null, 2)}</pre>
          <p className="muted">{rows.length} task rows synced to this tab</p>

          <h3>3 · Browser · projects ⟕ tasks, groupBy</h3>
          <table>
            <thead>
              <tr>
                <th>project</th>
                <th>tasks</th>
                <th>avg priority</th>
              </tr>
            </thead>
            <tbody>
              {perProject.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.tasks}</td>
                  <td>{p.tasks ? p.avgPriority.toFixed(1) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <h3>2 · Browser · tasks ⋈ projects ⟕ users ⟕ comment counts</h3>
          <table>
            <thead>
              <tr>
                <th>task</th>
                <th>project</th>
                <th>assignee</th>
                <th>prio</th>
                <th>status</th>
                <th>💬</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.id === selected ? 'selected' : undefined} onClick={() => setSelected(r.id)}>
                  <td>{r.title}</td>
                  <td>{r.project}</td>
                  <td>{r.assignee ?? <span className="muted">—</span>}</td>
                  <td>{'!'.repeat(r.priority)}</td>
                  <td>
                    <button
                      className="small"
                      onClick={(e) => {
                        e.stopPropagation()
                        track(tasks.update(r.id, (d) => void (d.status = NEXT[r.status])))
                      }}
                    >
                      {r.status} →
                    </button>
                  </td>
                  <td>{r.comments}</td>
                  <td>
                    <button
                      className="small"
                      onClick={(e) => {
                        e.stopPropagation()
                        track(tasks.delete(r.id))
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              if (!draft.title.trim()) return
              track(
                tasks.insert({
                  id: crypto.randomUUID(),
                  projectId: draft.projectId,
                  title: draft.title.trim(),
                  status: 'todo',
                  priority: draft.priority,
                  assigneeId: draft.assigneeId || null,
                  createdAt: Date.now(),
                }),
              )
              setDraft({ ...draft, title: '' })
            }}
          >
            <input className="grow" placeholder="new task" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <select value={draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}>
              {projectList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select value={draft.assigneeId} onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value })}>
              <option value="">unassigned</option>
              {people.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
            <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}>
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {'!'.repeat(n)}
                </option>
              ))}
            </select>
            <button type="submit">Add</button>
          </form>
          <p className="muted">
            A task outside the filter appears optimistically, then leaves once the server confirms it: the server never sends it back.
          </p>
          {error && <p className="error">{error}</p>}

          <h3>4 · Browser · comments ⟕ users, where taskId = selected</h3>
          {selectedTask ? (
            <>
              <b>{selectedTask.title}</b>
              <ul className="plain">
                {thread.map((c) => (
                  <li key={c.id}>
                    <b>{c.author ?? '?'}</b> {c.text}{' '}
                    <button className="small" title="author-only: someone else's rolls back" onClick={() => track(comments.delete(c.id))}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!comment.trim()) return
                  track(comments.insert({ id: crypto.randomUUID(), taskId: selectedTask.id, authorId: me, text: comment.trim(), createdAt: Date.now() }))
                  setComment('')
                }}
              >
                <input className="grow" placeholder="comment" value={comment} onChange={(e) => setComment(e.target.value)} />
                <button type="submit">Send</button>
              </form>
            </>
          ) : (
            <p className="muted">Click a task to open its comments.</p>
          )}
        </div>
      </div>
    </section>
  )
}
