import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// StrictMode is safe: clients are owned by useSuperLineClient / committed effects,
// so the dev-mode double-invoke opens and closes one extra properly-paired connection.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
