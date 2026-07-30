import { StrictMode, useState, type FormEvent } from 'react'
import type { ClientTransport } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { SuperLineProvider, useSuperLineClient, useCollection } from '@super-line/react'
import { app } from './todos-contract'

// Declare your contract + role ONCE and every module-level hook is typed by it —
// no factory call, no generics at call sites.
declare module '@super-line/react' {
  interface Register {
    contract: typeof app
    role: 'user'
  }
}

/** One "browser tab": owns a client (StrictMode-safe) and provides it to the hooks. */
export function TodoTab({ transport, user }: { transport: ClientTransport; user: string }) {
  // Built in a committed effect, closed on unmount — never leaks a socket under StrictMode.
  const client = useSuperLineClient(
    () => createSuperLineClient(app, { transport, role: 'user', params: { user } }),
    [transport, user],
  )
  return (
    <StrictMode>
      <SuperLineProvider client={client}>
        <TodoList user={user} />
      </SuperLineProvider>
    </StrictMode>
  )
}

function TodoList({ user }: { user: string }) {
  // A live, typed row-set: snapshot first (`ready`), then every change — yours and
  // the other tab's — lands in `rows` and re-renders this component.
  const { rows, ready, insert, update } = useCollection('todos', {
    orderBy: [{ field: 'createdAt', dir: 'asc' }],
  })
  const [draft, setDraft] = useState('')

  const add = async (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    await insert({ id: crypto.randomUUID(), text, done: false, createdAt: Date.now() })
  }

  return (
    <div className="ri-tab">
      <header className="ri-head">
        <b>{user}</b>
        <span className="ri-state">{ready ? `${rows.length} todos · live` : 'loading…'}</span>
      </header>
      <ul className="ri-list">
        {rows.map((todo) => (
          <li key={todo.id}>
            <label className={todo.done ? 'is-done' : ''}>
              <input
                type="checkbox"
                checked={todo.done}
                onChange={() => update({ ...todo, done: !todo.done })}
              />
              <span>{todo.text}</span>
            </label>
          </li>
        ))}
      </ul>
      <form className="ri-add" onSubmit={add}>
        <input
          className="ds-field"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`add a todo as ${user}`}
          aria-label={`add a todo as ${user}`}
        />
        <button className="ds-btn ds-btn--primary" type="submit" disabled={!ready || !draft.trim()}>
          add
        </button>
      </form>
    </div>
  )
}
