import { useEffect, useState } from 'react'
import { authClient } from '@super-line/plugin-auth/client'
import { SuperLineAuthProvider, useAuth, useEnv } from '@super-line/plugin-auth/react'
import { createSuperLineClient } from '@super-line/client'
import { devtoolsPlugin } from '@super-line/plugin-devtools'
import { Workspace } from '@/components/workspace'
import { Button } from '@/components/ui/button'
import { chat } from '@/contract'
import { assertionKind, readClaims, WIRE_LABEL, type BearerInfo } from '@/lib/jwt'
import { transport } from '@/lib/transport'

/**
 * The second way into this app: a connection authenticated by a bearer assertion instead of the access
 * token plugin-auth persists. It runs on its OWN `authClient` — `resolveToken` yields this tab's token and
 * `tokenParam: 'jwt'` routes it — mounted as a NESTED <SuperLineAuthProvider>, which shadows the app-wide
 * one for everything below. That is how a second, independent session coexists with the first: no second
 * binding, no second set of hooks, just another provider.
 *
 * A downstream sealed-only app wires its ONE provider exactly this way and skips the nesting.
 */
export function JwtSession({ token, onExit }: { token: string; onExit: () => void }): React.JSX.Element {
  const [auth] = useState(() =>
    authClient<typeof chat, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt', // → params:{ jwt } → authMethod 'jwt' / 'jwt-sealed'
      resolveToken: async () => ({ token }),
      // its own devtools instance too — this session is independent of the app-wide one, so the panel
      // lists it as a separate client rather than folding it into the same story
      connect: ({ role, params }) =>
        createSuperLineClient(chat, { transport, role: role as 'user', params, plugins: [devtoolsPlugin()] }),
    }),
  )
  useEffect(() => () => auth.client.close(), [auth])

  return (
    <SuperLineAuthProvider client={auth}>
      <BearerSession token={token} onExit={onExit} />
    </SuperLineAuthProvider>
  )
}

function BearerSession({ token, onExit }: { token: string; onExit: () => void }): React.JSX.Element {
  const { state } = useAuth()
  // Display only — the connection is already confirmed. A sealed token tells its holder nothing, so its
  // summary is whatever the server chose to vend as `env`; a signed one we can read ourselves.
  const env = useEnv()

  if (state.pending) {
    return (
      <div className="flex h-full items-center justify-center bg-sidebar text-muted-foreground">
        Connecting with a bearer token over {WIRE_LABEL}…
      </div>
    )
  }

  if (state.status !== 'authed') {
    return (
      <div className="flex h-full items-center justify-center bg-sidebar p-6">
        <div className="w-full max-w-sm rounded-xl bg-background p-8 text-center shadow-2xl">
          <p className="text-sm text-muted-foreground">
            {state.error?.reason ??
              'That token was rejected — it has expired, or it was not issued by this server.'}
          </p>
          <Button className="mt-4 w-full" onClick={onExit}>
            Back to sign-in
          </Button>
        </div>
      </div>
    )
  }

  const bearer: BearerInfo =
    assertionKind(token) === 'sealed' ? { kind: 'sealed', env } : { kind: 'signed', claims: readClaims(token)! }
  return <Workspace me={state.userId!} onSignOut={onExit} bearer={bearer} />
}
