import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// No StrictMode — it double-invokes effects in dev, which would build/tear-down the libp2p node twice.
createRoot(root).render(<App />)
