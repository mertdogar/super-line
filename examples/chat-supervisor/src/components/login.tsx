import { useState, type FormEvent } from 'react'
import { Network } from 'lucide-react'
import { SuperLineError } from '@super-line/core'
import { useAuth } from '@/lib/auth'

const field =
  'mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring'

export function Login(): React.JSX.Element {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'signup') await signUp({ email: email.trim(), password, displayName: displayName.trim() })
      else await signIn({ email: email.trim(), password })
    } catch (err) {
      setError(err instanceof SuperLineError ? err.message : 'Something went wrong')
      setBusy(false)
    }
  }

  const disabled = busy || !email.trim() || !password || (mode === 'signup' && !displayName.trim())

  return (
    <div className="flex h-full items-center justify-center bg-sidebar p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl bg-background p-8 shadow-2xl">
        <div className="flex items-center gap-2 text-primary">
          <Network className="h-7 w-7" />
          <span className="text-2xl font-bold tracking-tight text-foreground">chat supervisor</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          A Mastra supervisor delegating to a subagent, streamed live into a{' '}
          <span className="font-medium">@super-line/plugin-chat</span> channel — no harness.
        </p>

        {mode === 'signup' && (
          <>
            <label className="mt-6 block text-sm font-medium" htmlFor="displayName">
              Display name
            </label>
            <input id="displayName" className={field} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Ada" />
          </>
        )}

        <label className="mt-4 block text-sm font-medium" htmlFor="email">
          Email
        </label>
        <input id="email" type="email" autoFocus className={field} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" />

        <label className="mt-4 block text-sm font-medium" htmlFor="password">
          Password
        </label>
        <input id="password" type="password" className={field} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="at least 6 characters" />

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <button
          type="submit"
          disabled={disabled}
          className="mt-4 h-11 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? '…' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin')
            setError(null)
          }}
          className="mt-3 w-full text-center text-sm text-muted-foreground hover:text-foreground"
        >
          {mode === 'signin' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  )
}
