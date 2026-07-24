import { useEffect, useState } from 'react'
import { authClient } from '@super-line/plugin-auth/client'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { Workspace } from '@/components/workspace'
import { Button } from '@/components/ui/button'
import { chat } from '@/contract'
import { assertionKind, readClaims, WIRE_LABEL, type BearerInfo } from '@/lib/jwt'
import { transport } from '@/lib/transport'

type Session =
  | { status: 'connecting' }
  | { status: 'authed'; client: SuperLineClient<typeof chat, 'user'>; me: string; bearer: BearerInfo }
  | { status: 'rejected'; reason: string }

/**
 * The second way into this app: a connection authenticated by a bearer assertion instead of the access
 * token plugin-auth persists. It drives that connection through the SAME helper `useAuth()` uses —
 * `authClient` with `resolveToken` (this tab's token) and `tokenParam: 'jwt'` — so the guest-first connect,
 * the `whoami` confirm, and the `state.error` on rejection are the LIBRARY's, not hand-rolled here. A
 * downstream sealed-only app wires `createAuth` exactly this way.
 *
 * (A one-shot handoff like this could equally `createSuperLineClient(..., params:{ jwt })` directly — the
 * helper's real value is the guest↔authed swap a full app needs. The only cost here is one near-instant
 * guest socket before the swap; the win is deleting the bespoke confirm/reject handling this file used to do.)
 *
 * What stays bespoke is display-only: a signed token this tab can decode locally (`readClaims`); a sealed one
 * it cannot, so a sealed summary comes from the public half the server vended over `env`.
 */
export function JwtSession({ token, onExit }: { token: string; onExit: () => void }): React.JSX.Element {
  const [session, setSession] = useState<Session>({ status: 'connecting' })

  useEffect(() => {
    const auth = authClient<typeof chat, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt', // → params:{ jwt } → authMethod 'jwt' / 'jwt-sealed'
      resolveToken: async () => ({ token }),
      connect: ({ role, params }) => createSuperLineClient(chat, { transport, role: role as 'user', params }),
    })
    let cancelled = false

    void auth.ready.then(async () => {
      if (cancelled) return
      if (auth.state.status !== 'authed') {
        setSession({
          status: 'rejected',
          reason: auth.state.error?.reason ?? 'That token was rejected — it has expired, or it was not issued by this server.',
        })
        return
      }
      // Display only — the connection is already confirmed. A sealed token tells its holder nothing, so its
      // summary is whatever the server chose to vend as `env`; a signed one we can read ourselves.
      let bearer: BearerInfo
      if (assertionKind(token) === 'sealed') {
        await auth.client.env.ready
        if (cancelled) return
        bearer = { kind: 'sealed', env: auth.client.env.current }
      } else {
        bearer = { kind: 'signed', claims: readClaims(token)! }
      }
      setSession({ status: 'authed', client: auth.client, me: auth.state.userId!, bearer })
    })

    return () => {
      cancelled = true
      auth.client.close()
    }
  }, [token])

  if (session.status === 'connecting') {
    return (
      <div className="flex h-full items-center justify-center bg-sidebar text-muted-foreground">
        Connecting with a bearer token over {WIRE_LABEL}…
      </div>
    )
  }

  if (session.status === 'rejected') {
    return (
      <div className="flex h-full items-center justify-center bg-sidebar p-6">
        <div className="w-full max-w-sm rounded-xl bg-background p-8 text-center shadow-2xl">
          <p className="text-sm text-muted-foreground">{session.reason}</p>
          <Button className="mt-4 w-full" onClick={onExit}>
            Back to sign-in
          </Button>
        </div>
      </div>
    )
  }

  return <Workspace client={session.client} me={session.me} onSignOut={onExit} bearer={session.bearer} />
}
