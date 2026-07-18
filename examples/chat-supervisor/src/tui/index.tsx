// Entry point: bun src/tui/index.tsx
//
// Two faces on one cockpit — the OpenTUI terminal UI, or the headless stdin/stdout shell (ticket
// 08), chosen by config (`--headless` or a non-TTY stdout). The split is via dynamic import() on
// BOTH branches so @opentui/* and its native binaries never load in the headless path.

import { parseConfig } from './config'

const config = parseConfig()

if (config.headless) {
  const { runHeadless } = await import('./headless')
  await runHeadless(config)
} else {
  const { createCliRenderer } = await import('@opentui/core')
  const { createRoot } = await import('@opentui/react')
  const { AuthProvider } = await import('./auth')
  const { App } = await import('./app')

  const renderer = await createCliRenderer({ exitOnCtrlC: true, screenMode: 'alternate-screen' })
  const quit = () => {
    renderer.destroy()
    process.exit(0)
  }
  createRoot(renderer).render(
    <AuthProvider>
      <App quit={quit} />
    </AuthProvider>,
  )
}
