# How to Mint Sealed Tokens Server-Side

This tutorial guides you through the process of minting a **sealed token (JWE)** on the server using the Super-Line auth plugin. 

A sealed token is an opaque bearer assertion. Unlike a signed token (JWS) whose claims can be read by anyone holding it, a sealed token can only be decrypted and read by the server that minted it. This makes it ideal for carrying sensitive server state across client environments without leaking information.

## Prerequisites

Before starting, ensure you have:
1. An existing Super-Line backend with `@super-line/plugin-auth` installed.
2. The `jwt` configuration enabled on your `authKit` initialization.

```typescript
// Example auth kit setup
import { auth } from '@super-line/plugin-auth/server'

const authKit = auth({ 
  contract: myAppContract, 
  collections: myBackendStore,
  jwt: { secret: process.env.JWT_SECRET } // Required for minting
})
```

## Step 1: Accessing the Auth Kit inside an API Route

To mint a sealed token, you must execute the code in a server environment (e.g., an Express route, an RPC endpoint, or a serverless function) where the `authKit` instance is available. 

> [!WARNING]
> You cannot mint a token from the client at all — signed or sealed. There is deliberately no client-facing mint; all minting is server-side (`authKit.tokens.mintSigned` / `mintSealed`).

```typescript
// Example Express route
app.post('/api/exchange-for-sealed', async (req, res) => {
  // We assume the user is authenticated and we know their ID
  const userId = req.user.id; 
  
  // Proceed to Step 2...
});
```

## Step 2: Defining the Payload

A sealed token can carry two types of payloads:
- `claims`: A public payload (though still opaque to the client in a JWE).
- `sealed`: A strictly private, server-only payload that you want to hide from the client but retrieve later when the token is verified.

Let's define a payload. For example, you might want to give the client a token that grants them temporary access to a specific resource without exposing the underlying resource ID or parameters.

```typescript
const payloadOptions = {
  claims: {
    purpose: 'temporary-resource-access'
  },
  sealed: {
    resourceId: 'hidden-id-12345',
    internalPermissions: ['read', 'execute']
  },
  expiresInMs: 1000 * 60 * 15 // 15 minutes
};
```

## Step 3: Minting the Token

Use the `authKit.tokens.mintSealed` method. This method takes the `userId` and the options object we defined above.

> [!IMPORTANT]
> The user must exist and be active. If the user has been deactivated (soft-deleted), `mintSealed` will throw a `CONFLICT` error.

```typescript
app.post('/api/exchange-for-sealed', async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Mint the sealed token
    const { token, expiresAt } = await authKit.tokens.mintSealed(userId, {
      claims: { purpose: 'temporary-resource-access' },
      sealed: { resourceId: 'hidden-id-12345' },
      expiresInMs: 1000 * 60 * 15
    });

    // Proceed to Step 4...
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
```

## Step 4: Handling the Token

Finally, return the minted token to the client. The client will store this opaque string and pass it back to the server in the `jwt` query parameter when connecting to the Super-Line server.

```typescript
    // ... inside the try block
    
    // Return the token to the client
    res.json({ 
      sealedToken: token, 
      expiresAt 
    });
```

When the client later connects using this token (`?jwt=<token>`), the Super-Line auth plugin will automatically decrypt it, verify the expiration, read the user's current roles directly from the database, and attach both the `claims` and `sealed` payloads to the connection's `AuthContext`.

## Conclusion

You have successfully minted a sealed token on the server. The client now holds an opaque credential that safely carries internal server state without leaking any data. For a broader understanding of why this mechanism exists and how it fits into the auth architecture, see the [Auth Lifecycle & Sealed Tokens Explanation](./explanation-auth-lifecycle-sealed-tokens.md).
