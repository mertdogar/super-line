import { useEffect, useState } from 'react'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { Workspace } from '@/components/workspace'
import { Button } from '@/components/ui/button'
import { chat } from '@/contract'
import { assertionKind, readClaims, WIRE_LABEL, type BearerInfo } from '@/lib/jwt'
import { transport } from '@/lib/transport'

type Session =
  | { status: 'connecting' }
  | { status: 'ready'; client: SuperLineClient<typeof chat, 'user'>; me: string; bearer: BearerInfo }
  | { status: 'rejected'; reason: string }

/**
 * The second way into this app: a connection authenticated by a bearer assertion instead of the access
 * token `plugin-auth` persists. It deliberately sits BESIDE `useAuth()` rather than inside it —
 * `authClient` hardcodes its handshake params (`{}` as guest, `{ token }` as authed), and an assertion
 * is a different credential with a different lifecycle, not a variant of that one.
 *
 * Both kinds land here. The difference is what this component can find out on its own: a signed token
 * it decodes locally, a sealed one it cannot read at all — so everything it displays for a sealed
 * session had to be told to it by the server, over `env`.
 */
export function JwtSession({ token, onExit }: { token: string; onExit: () => void }): React.JSX.Element {
  const [session, setSession] = useState<Session>({ status: 'connecting' })

  useEffect(() => {
    const kind = assertionKind(token)
    if (!kind) {
      setSession({ status: 'rejected', reason: 'That does not look like a bearer assertion.' })
      return
    }
    const claims = kind === 'signed' ? readClaims(token) : null
    if (kind === 'signed' && !claims) {
      setSession({ status: 'rejected', reason: 'That token is malformed.' })
      return
    }

    // The transport is this tab's wire — an assertion is orthogonal to it, so the handoff link can land
    // on any of the three. `params: { jwt }` is the whole of the client-side connect API, for both kinds.
    const client = createSuperLineClient(chat, { transport, role: 'user', params: { jwt: token } })
    let cancelled = false

    // A failed assertion does NOT fail the connect: `authenticate` resolves to `guest` and the server
    // accepts the connection at that role, so a client built as `user` would silently NOT_FOUND on every
    // call. `whoami` is on `shared`, so it answers on either role — null means we came in as a guest.
    // This is the same confirm-then-trust step plugin-auth's own client does for a restored token.
    void client
      .whoami()
      .then(async (who) => {
        if (cancelled) return
        if (!who) {
          client.close()
          setSession({ status: 'rejected', reason: 'That token was rejected — it has expired, or it was not issued by this server.' })
          return
        }
        // For a sealed token this is the ONLY way to learn what it carries: the server chose to vend
        // the public half as env. The sealed half is never on the wire, so it can't be shown here.
        if (kind === 'sealed') await client.env.ready
        if (cancelled) return
        const bearer: BearerInfo =
          kind === 'signed' ? { kind: 'signed', claims: claims! } : { kind: 'sealed', env: client.env.current }
        setSession({ status: 'ready', client, me: who.userId, bearer })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        client.close()
        setSession({ status: 'rejected', reason: err instanceof Error ? err.message : 'Could not connect.' })
      })

    return () => {
      cancelled = true
      client.close()
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
