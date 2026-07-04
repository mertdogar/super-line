import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// No StrictMode — it double-invokes effects in dev, which would open/close the live socket twice.
createRoot(root).render(<App />)
