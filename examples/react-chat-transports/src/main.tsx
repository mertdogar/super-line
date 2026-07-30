import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SuperLineAuthProvider } from '@super-line/plugin-auth/react'
import { authOptions } from './lib/auth'
import { App } from './App'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// StrictMode is safe: the providers build their clients in committed effects, so the dev-mode
// double-invoke opens and closes one extra properly-paired connection.
createRoot(root).render(
  <StrictMode>
    <SuperLineAuthProvider {...authOptions}>
      <App />
    </SuperLineAuthProvider>
  </StrictMode>,
)
