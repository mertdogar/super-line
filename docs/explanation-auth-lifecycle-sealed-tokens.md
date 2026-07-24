# The Auth Lifecycle & Sealed Tokens

This document provides a conceptual overview of the Super-Line auth plugin lifecycle, focusing on the architectural design behind bearer assertions and the deliberate asymmetry between **signed (JWS)** and **sealed (JWE)** tokens.

## The Authentication Lifecycle

In a Super-Line application, authentication is typically handled through a combination of long-lived credentials, short-lived session access tokens, and bearer assertions. 

The standard lifecycle looks like this:
1. **Sign In**: A client authenticates (e.g., email/password) and receives a short-lived `access-token`.
2. **Session Connection**: The client connects to the Super-Line server, establishing a stateful session. The `AuthContext` tracks the user's ID, roles, and connection metadata.
3. **Assertion Minting**: An authenticated client or the server can generate a bearer assertion (a JWT) to pass state or grant temporary access elsewhere.
4. **Stateless Connection**: A client can connect using the assertion (via `?jwt=<token>`), allowing the server to statelessly authenticate the user and read the token's payloads without needing a database session lookup.

## Signed vs. Sealed Tokens: The Deliberate Asymmetry (ADR-0015)

Super-Line's auth plugin supports two distinct types of bearer assertions. This system was designed with a deliberate asymmetry (documented in ADR-0015) regarding how the tokens are minted and what they expose.

### Signed Tokens (JWS)
- **Format**: JSON Web Signature (JWS).
- **Visibility**: The `claims` payload is public. Anyone who intercepts or holds the token can decode it (e.g., via `jwt.io`) and read the data.
- **Verification**: Third-party services holding your public verification key can verify the signature and trust the claims.
- **Minting**: **Client-Mintable.** Any authenticated client can request a signed token via the `getToken` API. The client authors the public `claims`.

### Sealed Tokens (JWE)
- **Format**: JSON Web Encryption (JWE) using AEAD (Authenticated Encryption with Associated Data).
- **Visibility**: The `sealed` payload (and any `claims`) is entirely opaque to the token's holder. It tells its holder NOTHING. 
- **Verification**: Only the deployment holding the original secret key can decrypt and verify the token.
- **Minting**: **Server-Minted Only.** There is no client-facing API to mint a sealed token. It is generated exclusively via `authKit.tokens.mintSealed` on the server.

## Why are Sealed Tokens Server-Minted Only?

This restriction is a fundamental security mechanism. Because the client cannot read *or* generate the contents of a sealed token, any `sealed` payload attached to a verified connection's `AuthContext` is **guaranteed to be server-authored data**.

If clients were allowed to mint sealed tokens, a malicious actor could embed arbitrary data into the token. Since the server cannot distinguish between client-authored and server-authored encrypted payloads upon receipt, trusting the `sealed` payload would become unsafe. By restricting minting strictly to the server environment, Super-Line ensures that when your connection handler reads `ctx.sealed`, that data unquestionably originated from your trusted backend logic.

## Common Use Cases

Understanding the differences helps architects choose the correct token type:

- **Use a Signed Token (JWS) when:** 
  - You need to pass identity context to a third-party service (e.g., an external API that needs to know who the user is).
  - The client needs to read the token's contents to drive UI logic.
  - The payloads contain no sensitive internal data.

- **Use a Sealed Token (JWE) when:**
  - You need to issue temporary access to a specific internal resource (e.g., a secure download link or an invite code).
  - The token carries sensitive routing flags, internal permissions, or state that must not be exposed to the client or network sniffers.
  - You want to guarantee that the payload data was authored exclusively by the server.

## Conclusion

Sealed tokens are a powerful tool for maintaining tight security invariants in distributed or stateful applications. By leveraging AEAD encryption and strictly restricting minting to the server, Super-Line provides a mechanism to safely transport server-authored state through untrusted client environments.
