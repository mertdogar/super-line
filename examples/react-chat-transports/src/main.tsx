import { createRoot } from 'react-dom/client'
import { AuthProvider } from './lib/auth'
import { App } from './App'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// No StrictMode: it double-invokes effects in dev, which would open/close the live connection twice.
createRoot(root).render(
  <AuthProvider>
    <App />
  </AuthProvider>,
)
