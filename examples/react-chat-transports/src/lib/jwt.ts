import { useEffect, useState } from 'react'
import { decodeJwt } from 'jose'
import { kind, TRANSPORT_LABELS, type TransportKind } from '@/lib/transport'

// The bearer-token half of the demo. plugin-auth mints a short-lived signed JWT from a live session
// (`getToken`) and accepts one at connect (`params: { jwt }`) — two separate capabilities, and this
// module is the browser's side of both.

export interface Claims {
  userId: string
  roles: string[]
  issuedAt: number
  expiresAt: number
}

/**
 * Read a JWT's claims WITHOUT verifying it. Safe here only because these claims are used for display
 * and to label the connection — never to decide anything. The signature check that matters happens on
 * the server at connect, and in the verifier service.
 */
export function readClaims(token: string): Claims | null {
  try {
    const p = decodeJwt(token)
    if (!p.sub || !p.exp) return null
    return { userId: p.sub, roles: Array.isArray(p.roles) ? (p.roles as string[]) : [], issuedAt: (p.iat ?? 0) * 1000, expiresAt: p.exp * 1000 }
  } catch {
    return null
  }
}

/**
 * A live "expires in m:ss" for a claim set — the one place the token's short life is visible.
 *
 * Worth knowing what it does and does not mean: a JWT is checked at CONNECT and never again, so an
 * open connection outlives its token. What runs out here is the ability to start a NEW one.
 */
export function useExpiry(expiresAt: number): { remainingMs: number; label: string } {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const remainingMs = Math.max(0, expiresAt - now)
  if (remainingMs === 0) return { remainingMs, label: 'expired' }
  const total = Math.round(remainingMs / 1000)
  return { remainingMs, label: `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}` }
}

/** A handoff link: the same app, this token, on whichever wire you pick. */
export function handoffUrl(token: string, wire: TransportKind): string {
  const url = new URL(location.href)
  url.search = ''
  url.searchParams.set('transport', wire)
  url.searchParams.set('jwt', token)
  return url.toString()
}

export const WIRE_LABEL = TRANSPORT_LABELS[kind]

/** The JWT this tab was opened with, if any. Read once at module scope, before the URL is cleaned. */
export const jwtFromUrl: string | null = new URLSearchParams(location.search).get('jwt')

/**
 * Drop the token out of the address bar as soon as it has been used.
 *
 * A URL is the wrong home for a bearer credential — it lands in history, in the referrer, in a shared
 * screenshot — so the link is a convenience for THIS demo, not a pattern to copy; a real handoff uses
 * an `Authorization` header or a one-time exchange code. The cost of cleaning it is that reloading a
 * handed-off tab returns you to the login screen, since the token is gone.
 */
export function stripJwtFromUrl(): void {
  const url = new URL(location.href)
  if (!url.searchParams.has('jwt')) return
  url.searchParams.delete('jwt')
  history.replaceState(null, '', url)
}
