import http from 'node:http'
import { jwtVerify } from 'jose'

// A DIFFERENT backend. Look at what this file imports: `node:http` and `jose`. No super-line, no
// contract, no collections, no database — it cannot reach the chat server's sqlite file and does not
// know its address. All it holds is the shared signing secret, and that is enough to trust a caller.
//
// This is the point of a JWT and the reason it is worth having next to access tokens: an access token
// is a lookup key (whoever validates it needs the database), while a JWT is a signed assertion that
// anyone holding the secret can check on its own.
const PORT = Number(process.env.VERIFIER_PORT ?? 8788)
const secret = new TextEncoder().encode(process.env.AUTH_JWT_SECRET ?? 'dev-only-insecure-shared-secret')

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  if ((req.url ?? '').split('?')[0] !== '/api/verify') return json(res, 404, { error: 'not found' })

  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /i, '')
  if (!bearer) return json(res, 401, { error: 'no bearer token' })

  try {
    // Signature + `exp` in one call, entirely offline. An expired or tampered token throws here.
    const { payload } = await jwtVerify(bearer, secret)
    json(res, 200, {
      userId: payload.sub,
      roles: payload.roles ?? [],
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      verifiedBy: 'verifier — no super-line, no database, secret only',
    })
  } catch (err) {
    // jose names the failure: JWTExpired, JWSSignatureVerificationFailed, …
    json(res, 401, { error: err instanceof Error ? err.message : 'invalid token' })
  }
})

server.listen(PORT, () => {
  console.log(`[verifier] up on :${PORT} — GET /api/verify with an Authorization: Bearer <jwt> header`)
})
