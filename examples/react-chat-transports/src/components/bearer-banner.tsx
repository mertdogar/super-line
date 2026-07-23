import { KeyRound, Lock, X } from 'lucide-react'
import { useExpiry, WIRE_LABEL, type BearerInfo } from '@/lib/jwt'

/**
 * A bearer tab is otherwise pixel-identical to a normal one, so it says so. (The same lesson as the
 * per-message wire badge: if the thing being demonstrated isn't rendered, the demo doesn't exist.)
 *
 * The two kinds get different banners because the browser genuinely knows different things. For a
 * signed assertion it decoded the claims itself, down to the expiry, and can run a countdown. For a
 * sealed one it holds ciphertext: no subject, no roles, no expiry — only what the server chose to vend
 * as `env`. The asymmetry in this component IS the feature.
 */
export function BearerBanner({ bearer, onExit }: { bearer: BearerInfo; onExit: () => void }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-900 dark:text-amber-200">
      {bearer.kind === 'signed' ? <KeyRound className="h-4 w-4 shrink-0" /> : <Lock className="h-4 w-4 shrink-0" />}
      {bearer.kind === 'signed' ? <SignedSummary expiresAt={bearer.claims.expiresAt} /> : <SealedSummary env={bearer.env} />}
      <button
        type="button"
        onClick={onExit}
        title="Leave this bearer session"
        aria-label="Leave this bearer session"
        className="grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-amber-500/20"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

function SignedSummary({ expiresAt }: { expiresAt: number }): React.JSX.Element {
  const { remainingMs, label } = useExpiry(expiresAt)
  return (
    <>
      <span>
        Connected with a <span className="font-semibold">signed assertion</span> over{' '}
        <span className="font-semibold">{WIRE_LABEL}</span> — no access token stored, nothing in{' '}
        <code className="font-mono text-xs">localStorage</code>.
      </span>
      <span className="ml-auto shrink-0 font-mono text-xs">
        {remainingMs > 0 ? (
          <>token expires in {label}</>
        ) : (
          // The connection is still live: it was authorized once, at connect. Only a NEW connection
          // would be refused now — which is exactly what the dialog's Verify button demonstrates.
          <>token expired — this connection lives on</>
        )}
      </span>
    </>
  )
}

function SealedSummary({ env }: { env: { workspace: string } | null }): React.JSX.Element {
  return (
    <>
      <span>
        Connected with a <span className="font-semibold">sealed assertion</span> over{' '}
        <span className="font-semibold">{WIRE_LABEL}</span> — this tab is carrying a payload it{' '}
        <span className="font-semibold">cannot read</span>, not even to check when it expires.
      </span>
      <span className="ml-auto shrink-0 font-mono text-xs">
        {/* Everything here was told to us by the server via `env`. The sealed half never reaches the browser. */}
        {env ? <>env: workspace={env.workspace}</> : <>no env vended</>}
      </span>
    </>
  )
}
