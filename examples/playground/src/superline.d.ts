// Types every module-level hook in '@super-line/react' (and plugin-chat's react hooks) for this app.
import type { app } from './contract'

declare module '@super-line/react' {
  interface Register {
    contract: typeof app
    role: 'user'
  }
}
