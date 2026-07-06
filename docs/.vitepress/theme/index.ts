import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import CopyOrDownloadAsMarkdownButtons from 'vitepress-plugin-llms/vitepress-components/CopyOrDownloadAsMarkdownButtons.vue'
import SuperHome from './components/SuperHome.vue'
import './styles/brand.css'

// Friendly aliases for URLs people guess: /guide/why and @-less reference
// slugs. Runs in enhanceApp so the 404 shell redirects direct hits too.
const EXTRACTED = new Set([
  'core',
  'server',
  'client',
  'react',
  'adapter-redis',
  'adapter-libp2p',
  'adapter-zeromq',
  'adapter-rabbitmq',
])

const GUIDE_ALIASES: Record<string, string> = {
  'transport-websocket': 'transport-websocket',
  'transport-http': 'transport-http',
  'transport-libp2p': 'transport-libp2p',
  'transport-loopback': 'transport-loopback',
  'control-center': 'control-center',
  'store-memory': 'store',
  'store-sqlite': 'store',
  'store-sync': 'synced-state',
  'store-pglite': 'choosing-a-store',
  'store-sync-pglite': 'store-sync-pglite',
}

function redirectAliases() {
  const path = location.pathname.replace(/\.html$/, '').replace(/\/$/, '')
  if (path === '/guide/why') return location.replace('/guide/introduction')
  const m = path.match(/^\/reference\/([\w-]+)$/)
  if (!m) return
  if (EXTRACTED.has(m[1])) location.replace(`/reference/@super-line/${m[1]}/`)
  else if (GUIDE_ALIASES[m[1]]) location.replace(`/guide/${GUIDE_ALIASES[m[1]]}`)
}

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('SuperHome', SuperHome)
    app.component('CopyOrDownloadAsMarkdownButtons', CopyOrDownloadAsMarkdownButtons)
    if (typeof window !== 'undefined') redirectAliases()
  },
} satisfies Theme
