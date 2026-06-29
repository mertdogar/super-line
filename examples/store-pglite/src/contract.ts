import { defineContract } from '@super-line/core'

// Stores ride super-line's built-in store wire (off-contract), so the contract only needs a role to exist.
export const contract = defineContract({ roles: { user: { clientToServer: {} } } })
