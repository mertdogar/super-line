import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import CopyOrDownloadAsMarkdownButtons from 'vitepress-plugin-llms/vitepress-components/CopyOrDownloadAsMarkdownButtons.vue'
import SuperHome from './components/SuperHome.vue'
import './styles/brand.css'

// Friendly aliases for legacy /guide/* URLs and @-less reference
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

// @-less reference slugs that live as how-to recipes rather than extracted API.
const REFERENCE_GUIDE_ALIASES: Record<string, string> = {
  'transport-websocket': '/how-to/transport-websocket',
  'transport-http': '/how-to/transport-http',
  'transport-libp2p': '/how-to/transport-libp2p',
  'transport-loopback': '/how-to/transport-loopback',
  'control-center': '/how-to/control-center',
}

function redirectAliases() {
  const path = location.pathname.replace(/\.html$/, '').replace(/\/$/, '')
  if (path === '/guide/getting-started') return location.replace('/tutorials/first-round-trip')
  if (path === '/guide/the-contract') return location.replace('/concepts/the-contract')
  if (path === '/guide/why') return location.replace('/concepts/why-super-line')
  // Auth docs relocated into the first-class Authentication section (2026-07-24).
  if (path === '/tutorial-minting-sealed-tokens') return location.replace('/how-to/auth-jwt-sealed-tokens')
  if (path === '/explanation-auth-lifecycle-sealed-tokens') return location.replace('/concepts/auth-lifecycle-sealed-tokens')
  const m = path.match(/^\/reference\/([\w-]+)$/)
  if (!m) return
  if (EXTRACTED.has(m[1])) location.replace(`/reference/@super-line/${m[1]}/`)
  else if (REFERENCE_GUIDE_ALIASES[m[1]]) location.replace(REFERENCE_GUIDE_ALIASES[m[1]])
}

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('SuperHome', SuperHome)
    app.component('CopyOrDownloadAsMarkdownButtons', CopyOrDownloadAsMarkdownButtons)
    if (typeof window !== 'undefined') redirectAliases()
  },
} satisfies Theme
