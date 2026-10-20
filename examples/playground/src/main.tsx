import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createSuperLineClient } from '@super-line/client'
import { devtoolsPlugin } from '@super-line/plugin-devtools'
import { SuperLineAuthProvider } from '@super-line/plugin-auth/react'
import type { AuthClientOptions, TokenStorage } from '@super-line/plugin-auth/react'
import { app } from './contract'
import { App } from './App'
import { transport } from './dial'
import './styles.css'

// sessionStorage, not the default localStorage: one identity PER TAB, so Ada and Grace can sit side by side
// in the same browser. A reload keeps the tab signed in.
const storage: TokenStorage = {
  get: () => sessionStorage.getItem('playground.token'),
  set: (token) => (token ? sessionStorage.setItem('playground.token', token) : sessionStorage.removeItem('playground.token')),
}

const authOptions = {
  authedRole: 'user',
  storage,
  connect: ({ role, params }) =>
    createSuperLineClient(app, {
      transport,
      role: role as 'user',
      params,
      plugins: [devtoolsPlugin()],
    }),
} satisfies AuthClientOptions<typeof app, 'user'>

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SuperLineAuthProvider {...authOptions}>
      <App />
    </SuperLineAuthProvider>
  </StrictMode>,
)
