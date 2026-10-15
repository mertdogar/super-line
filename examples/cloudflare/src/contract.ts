import { defineContract } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

// Identity (users, sessions, the `guest` role) comes from plugin-auth and the chat model from plugin-chat. The
// host only names the role a signed-in user connects as.
export const contract = defineContract({
  roles: { user: {} },
  plugins: [authContract(), chatContract()],
})
