import { createRoot } from 'react-dom/client'
import { SuperLineAuthProvider } from '@super-line/plugin-auth/react'
import { authOptions } from './lib/auth'
import { App } from './App'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// No StrictMode: it double-invokes effects in dev, which would open/close the live WebSocket twice.
createRoot(root).render(
  <SuperLineAuthProvider {...authOptions}>
    <App />
  </SuperLineAuthProvider>,
)
