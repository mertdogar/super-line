import { useState } from 'react'
import { Check, Copy, ExternalLink, KeyRound, Lock, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { handoffUrl, readClaims, useExpiry, type Claims } from '@/lib/jwt'
import { TRANSPORT_LABELS, type TransportKind } from '@/lib/transport'
import { cn } from '@/lib/utils'

const WIRES = Object.keys(TRANSPORT_LABELS) as TransportKind[]

interface Minted {
  jwt: string
  claims: Claims
}

/**
 * The bearer-token panel: mint a JWT from this live session, watch it expire, have a service that
 * knows nothing about super-line verify it, and hand it to another tab on another wire.
 */
export function TokenDialog(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [minted, setMinted] = useState<Minted | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const mint = async () => {
    setBusy(true)
    setError(null)
    try {
      // No client-facing mint anymore (ADR-0015): the browser presents the access token it already holds
      // and the SERVER signs a short-lived assertion for it, over `/signed-token`.
      const accessToken = localStorage.getItem('superline.auth.token') ?? ''
      const res = await fetch('/signed-token', { headers: { authorization: `Bearer ${accessToken}` } })
      const body = (await res.json()) as { jwt?: string; error?: string }
      if (!res.ok || !body.jwt) throw new Error(body.error ?? 'could not get a token')
      const claims = readClaims(body.jwt)
      if (!claims) throw new Error('could not read the minted token')
      setMinted({ jwt: body.jwt, claims })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not get a token')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setMinted(null)
          setError(null)
        }
      }}
    >
      <DialogTrigger
        className="grid h-6 w-6 place-items-center rounded text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
        aria-label="Bearer token"
        title="Bearer token"
      >
        <KeyRound className="h-3.5 w-3.5" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Bearer token</DialogTitle>
          <DialogDescription>
            A short-lived signed JWT the server issues for this session. Unlike the access token in{' '}
            <code className="font-mono text-xs">localStorage</code>, it is not stored anywhere — anyone with the
            signing secret can verify it without a database.
          </DialogDescription>
        </DialogHeader>

        {!minted ? (
          <div className="space-y-3">
            <Button onClick={mint} disabled={busy} className="w-full">
              {busy ? 'Minting…' : 'Mint a token'}
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        ) : (
          <MintedToken minted={minted} onMintAgain={mint} busy={busy} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MintedToken({
  minted,
  onMintAgain,
  busy,
}: {
  minted: Minted
  onMintAgain: () => void
  busy: boolean
}): React.JSX.Element {
  const { remainingMs, label } = useExpiry(minted.claims.expiresAt)
  const [copied, setCopied] = useState(false)
  const [verdict, setVerdict] = useState<{ ok: boolean; body: unknown } | null>(null)
  const [verifying, setVerifying] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(minted.jwt)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // The other backend. It shares one thing with the chat server — the signing secret — and reaches
  // neither its database nor its process. An expired or tampered token comes back 401 from here.
  const verify = async () => {
    setVerifying(true)
    try {
      const res = await fetch('/api/verify', { headers: { authorization: `Bearer ${minted.jwt}` } })
      setVerdict({ ok: res.ok, body: await res.json() })
    } catch (err) {
      setVerdict({ ok: false, body: { error: err instanceof Error ? err.message : 'verifier unreachable' } })
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="truncate font-mono text-xs">{minted.claims.userId}</dd>
        <dt className="text-muted-foreground">Roles</dt>
        <dd className="font-mono text-xs">{minted.claims.roles.join(', ') || '—'}</dd>
        <dt className="text-muted-foreground">Expires</dt>
        <dd className={cn('font-mono text-xs', remainingMs === 0 && 'text-destructive')}>
          {remainingMs > 0 ? `in ${label}` : 'expired'}
        </dd>
      </dl>

      <div className="space-y-1.5">
        <div className="max-h-24 overflow-y-auto rounded-md border border-input bg-muted/40 p-2 font-mono text-[11px] leading-relaxed break-all">
          {minted.jwt}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={copy}>
            {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy token'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={verify} disabled={verifying}>
            <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
            {verifying ? 'Verifying…' : 'Verify elsewhere'}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onMintAgain} disabled={busy}>
            Mint again
          </Button>
        </div>
      </div>

      {verdict && (
        <pre
          className={cn(
            'max-h-32 overflow-auto rounded-md border p-2 font-mono text-[11px]',
            verdict.ok ? 'border-online/40 bg-online/10' : 'border-destructive/40 bg-destructive/10',
          )}
        >
          {JSON.stringify(verdict.body, null, 2)}
        </pre>
      )}

      <Handoff token={minted.jwt} />
      <SealedExchange signed={minted.jwt} />
    </div>
  )
}

/** Open a token in another tab, on any wire. Works identically for both kinds of assertion. */
function Handoff({ token, sealed = false }: { token: string; sealed?: boolean }): React.JSX.Element {
  return (
    <div className="border-t pt-3">
      <p className="text-xs text-muted-foreground">
        Open this token in another tab, on any wire — it connects with{' '}
        <code className="font-mono">params: {'{ jwt }'}</code> and never touches{' '}
        <code className="font-mono">localStorage</code>, so it is the one way to hold two independent
        connections in a single browser.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {WIRES.map((wire) => (
          <a
            key={wire}
            href={handoffUrl(token, wire)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-input px-2.5 py-1 text-xs hover:bg-muted"
          >
            <ExternalLink className="h-3 w-3" />
            {TRANSPORT_LABELS[wire]}
          </a>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        A link is the wrong place for a real bearer credential — it lands in history and referrers. The
        receiving tab strips it from the address bar on arrival, and production would use an{' '}
        <code className="font-mono">Authorization</code> header or a one-time exchange code.
        {sealed && ' Sealing the payload does not change that: the token is still a bearer credential.'}
      </p>
    </div>
  )
}

/**
 * The other kind. A sealed assertion is a JWE: same handshake param, but its payload is encrypted, so
 * the browser holding it cannot read it — which is exactly what makes it safe to route a server secret
 * *through* a client. Neither kind is client-minted, so this trades the signed token we just fetched
 * for a sealed one at `/sealed-handoff`, and back-office code picks what to seal in.
 */
function SealedExchange({ signed }: { signed: string }): React.JSX.Element {
  const [sealed, setSealed] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const exchange = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/sealed-handoff', { headers: { authorization: `Bearer ${signed}` } })
      const body = (await res.json()) as { token?: string; error?: string }
      if (!res.ok || !body.token) throw new Error(body.error ?? 'exchange failed')
      setSealed(body.token)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not get a sealed token')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t pt-3">
      <div className="flex items-center gap-2">
        <Lock className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-sm font-medium">Sealed assertion</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Server-minted only. Carries a public half (vended back to the browser as{' '}
        <code className="font-mono">env</code>) and an encrypted half only the server can read.
      </p>

      {!sealed ? (
        <>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={exchange} disabled={busy}>
            {busy ? 'Exchanging…' : 'Exchange for a sealed token'}
          </Button>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="max-h-24 overflow-y-auto rounded-md border border-input bg-muted/40 p-2 font-mono text-[11px] leading-relaxed break-all">
            {sealed}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {sealed.split('.').length} parts, and{' '}
            <span className="font-semibold">{readClaims(sealed) ? 'readable' : 'unreadable'}</span> from here —
            a JWE has 5 segments and its payload is ciphertext. Open it below and the receiving tab will show
            you what the server says is inside, because it cannot look for itself.
          </p>
          <Handoff token={sealed} sealed />
        </div>
      )}
    </div>
  )
}
