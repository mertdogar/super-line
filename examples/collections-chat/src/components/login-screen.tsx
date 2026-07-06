import { useState, type FormEvent } from 'react'
import { MessageSquare } from 'lucide-react'
import { SuperLineError } from '@super-line/core'
import { useAuth } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function LoginScreen(): React.JSX.Element {
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
      // on success the auth state flips to `authed` and <App/> swaps to the workspace
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
          <MessageSquare className="h-7 w-7" />
          <span className="text-2xl font-bold tracking-tight text-foreground">super-line</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {mode === 'signup' ? 'Create an account' : 'Sign in'} to join the workspace. Accounts, sessions &amp;
          row-level security are provided by <span className="font-medium">@super-line/plugin-auth</span>.
        </p>

        {mode === 'signup' && (
          <>
            <label className="mt-6 block text-sm font-medium" htmlFor="displayName">
              Display name
            </label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Ada"
              className="mt-1.5 h-11"
            />
          </>
        )}

        <label className="mt-4 block text-sm font-medium" htmlFor="email">
          Email
        </label>
        <Input
          id="email"
          type="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="ada@example.com"
          className="mt-1.5 h-11"
        />

        <label className="mt-4 block text-sm font-medium" htmlFor="password">
          Password
        </label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="at least 6 characters"
          className="mt-1.5 h-11"
        />

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <Button type="submit" className="mt-4 h-11 w-full" disabled={disabled}>
          {busy ? '…' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </Button>
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
