import { useState } from 'react'
import { useRequest } from '@super-line/react'
import { useAuth } from '@super-line/plugin-auth/react'

export function AuthPanel(): React.JSX.Element {
  const auth = useAuth()
  const whoami = useRequest('whoami', undefined)
  const keys = useRequest('listApiKeys', undefined)
  const { call: createKey } = useRequest('createApiKey')
  const { call: revokeKey } = useRequest('revokeApiKey')
  const [label, setLabel] = useState('agent')
  const [fresh, setFresh] = useState<string | null>(null)

  return (
    <section className="panel">
      <h2>Auth · plugin-auth</h2>
      <pre>{JSON.stringify({ state: auth.state, whoami: whoami.data }, null, 2)}</pre>

      <h3>API keys</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          void createKey({ label, role: 'user' }).then((k) => {
            setFresh(k.key)
            void keys.refetch()
          })
        }}
      >
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit">Create key</button>
      </form>
      {fresh && (
        <p>
          shown once: <code>{fresh}</code>
        </p>
      )}
      <ul className="plain">
        {keys.data?.map((k) => (
          <li key={k.id}>
            {k.label} <span className="muted">({k.role})</span>{' '}
            <button className="small" onClick={() => void revokeKey({ id: k.id }).then(() => keys.refetch())}>
              revoke
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
