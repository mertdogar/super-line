import { KeyRound, X } from 'lucide-react'
import { useExpiry, WIRE_LABEL, type Claims } from '@/lib/jwt'

/**
 * A JWT tab is otherwise pixel-identical to a normal one, so it says so. (The same lesson as the
 * per-message wire badge: if the thing being demonstrated isn't rendered, the demo doesn't exist.)
 */
export function BearerBanner({ claims, onExit }: { claims: Claims; onExit: () => void }): React.JSX.Element {
  const { remainingMs, label } = useExpiry(claims.expiresAt)

  return (
    <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-900 dark:text-amber-200">
      <KeyRound className="h-4 w-4 shrink-0" />
      <span>
        Connected with a <span className="font-semibold">JWT</span> over{' '}
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
