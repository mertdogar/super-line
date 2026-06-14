import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// Note: no StrictMode — it double-invokes effects in dev, which would open/close the
// live WebSocket connection twice. Fine to add once you guard the client lifecycle.
createRoot(root).render(<App />)
