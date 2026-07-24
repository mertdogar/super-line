import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'
import llmstxt, { copyOrDownloadAsMarkdownButtons } from 'vitepress-plugin-llms'
import typedocSidebar from '../reference/typedoc-sidebar.json'

export default defineConfig({
  title: 'super-line',
  description:
    'End-to-end typesafe realtime for TypeScript — role-scoped contracts, req/res, rooms & topics from one contract, over WebSocket, HTTP, or libp2p.',
  base: '/',
  cleanUrls: true,
  lastUpdated: true,
  // PRODUCT.md and the ADRs are internal notes — keep the files, don't publish them.
  srcExclude: ['PRODUCT.md', 'adr/**'],
  head: [
    ['link', { rel: 'icon', href: '/mark.svg' }],
    [
      'link',
      {
        rel: 'preload',
        href: '/fonts/IoskeleyMono-Regular.woff2',
        as: 'font',
        type: 'font/woff2',
        crossorigin: '',
      },
    ],
  ],
  markdown: {
    config(md) {
      md.use(copyOrDownloadAsMarkdownButtons)
    },
  },
  vite: {
    plugins: [llmstxt({ domain: 'https://super-line.dogar.biz' })],
    resolve: {
      // The in-page ChatDemo runs the real plugin-chat server; its dist imports
      // `randomUUID` from Node's `crypto`. Point that at a browser shim.
      alias: {
        crypto: fileURLToPath(new URL('./shims/crypto.ts', import.meta.url)),
        'node:crypto': fileURLToPath(new URL('./shims/crypto.ts', import.meta.url)),
      },
    },
    build: {
      // The ClusterDemo runs a real super-line server in-browser. The server's
      // getContract() (inspector-only, never called here) lazily pulls the
      // optional standard-json schema converters for non-zod schema libs. Mark
      // those leaf deps external so Rollup doesn't try to resolve them — the code
      // path never executes in the demo.
      rollupOptions: {
        external: ['@valibot/to-json-schema', 'effect', 'sury', 'arktype', '@sinclair/typebox'],
      },
    },
  },
  themeConfig: {
    logo: '/mark.svg',
    // Diátaxis quadrants across the top: learn (Tutorials), do (How-to),
    // understand (Concepts), look up (Reference) — with Collections lifted out
    // as its own flagship section.
    nav: [
      { text: 'Tutorials', link: '/tutorials/', activeMatch: '/tutorials/' },
      { text: 'How-to', link: '/how-to/', activeMatch: '/how-to/' },
      { text: 'Concepts', link: '/concepts/', activeMatch: '/concepts/' },
      { text: 'Collections', link: '/collections/', activeMatch: '/collections/' },
      { text: 'Plugins', link: '/plugins/', activeMatch: '/plugins/' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Examples', link: '/examples/' },
    ],
    sidebar: {
      // ── Tutorials — the curated learning spine (few, guaranteed-success) ──
      '/tutorials/': [
        {
          text: 'Tutorials',
          items: [
            { text: 'The learning path', link: '/tutorials/' },
            { text: '1 · Your first typed round-trip', link: '/tutorials/first-round-trip' },
            { text: '2 · Your first collection', link: '/tutorials/first-collection' },
            { text: '3 · Go collaborative (a CRDT doc)', link: '/tutorials/go-collaborative' },
            { text: '4 · Add auth to your app', link: '/tutorials/add-auth-to-your-app' },
            { text: '5 · Assemble a chat backbone', link: '/tutorials/chat-backbone' },
            { text: '6 · Put a live AI agent in the chat', link: '/tutorials/ai-agent-chat' },
            { text: '7 · Co-edit a canvas with an agent', link: '/tutorials/collaborative-canvas-with-agent' },
          ],
        },
      ],
      // ── How-to — task-oriented recipes, grouped by area ──────────────────
      '/how-to/': [
        {
          text: 'Contract & interactions',
          collapsed: false,
          items: [
            { text: 'Implement requests', link: '/how-to/requests' },
            { text: 'Push events & broadcast to rooms', link: '/how-to/events-rooms' },
            { text: 'Subscribe to topics', link: '/how-to/topics' },
            { text: 'Use the cluster event bus', link: '/how-to/cluster-event-bus' },
          ],
        },
        {
          text: 'Transports',
          collapsed: true,
          items: [
            { text: 'Choose a transport', link: '/how-to/choose-a-transport' },
            { text: 'WebSocket', link: '/how-to/transport-websocket' },
            { text: 'HTTP — SSE & long-poll', link: '/how-to/transport-http' },
            { text: 'libp2p & WebRTC', link: '/how-to/transport-libp2p' },
            { text: 'Loopback (for tests)', link: '/how-to/transport-loopback' },
          ],
        },
        {
          text: 'Authentication',
          collapsed: true,
          items: [
            { text: 'Choose an auth strategy', link: '/how-to/choose-an-auth-strategy' },
            { text: 'Authenticate & assign roles', link: '/how-to/roles-auth' },
            { text: 'Add authentication (plugin)', link: '/how-to/plugin-auth' },
            { text: 'Sessions, roles & API keys', link: '/how-to/auth-sessions-roles-keys' },
            { text: 'JWT & sealed tokens', link: '/how-to/auth-jwt-sealed-tokens' },
            { text: 'Server-side hooks', link: '/how-to/auth-hooks' },
            { text: 'Provision an agent identity', link: '/how-to/auth-agent-identity' },
            { text: 'Reset a password', link: '/how-to/auth-password-reset' },
          ],
        },
        {
          text: 'Server',
          collapsed: true,
          items: [
            { text: 'Hand a connection its credentials (env)', link: '/how-to/connection-env' },
            { text: 'Add a chat backbone (plugin)', link: '/how-to/plugin-chat' },
            { text: 'Migrate chat from 0.4 to 0.5', link: '/how-to/plugin-chat-0-5-migration' },
            { text: 'Stream an agent’s turn', link: '/how-to/chat-streaming' },
            { text: 'Run an AI chat bot', link: '/how-to/chat-bots' },
            { text: 'Attach channel resources', link: '/how-to/chat-resources' },
            { text: 'Drive a channel from scripts', link: '/how-to/chat-headless' },
            { text: 'Hook the connection lifecycle', link: '/how-to/middleware-lifecycle' },
            { text: 'Handle errors', link: '/how-to/errors' },
            { text: 'Debug with logs', link: '/how-to/debugging-with-logs' },
            { text: 'Query presence & topology', link: '/how-to/introspection-and-presence' },
            { text: 'Compose / embed a library', link: '/how-to/composition' },
            { text: 'Build a plugin', link: '/how-to/building-plugins' },
          ],
        },
        {
          text: 'Client',
          collapsed: true,
          items: [
            { text: 'Use the React hooks', link: '/how-to/react' },
            { text: 'Configure serialization', link: '/how-to/serialization' },
          ],
        },
        {
          text: 'Scaling',
          collapsed: true,
          items: [
            { text: 'Choose an adapter', link: '/how-to/choose-an-adapter' },
            { text: 'Redis', link: '/how-to/adapter-redis' },
            { text: 'libp2p', link: '/how-to/adapter-libp2p' },
            { text: 'RabbitMQ', link: '/how-to/adapter-rabbitmq' },
            { text: 'ZeroMQ', link: '/how-to/adapter-zeromq' },
          ],
        },
        {
          text: 'Tooling & workflow',
          collapsed: true,
          items: [
            { text: 'Inspect with Control Center', link: '/how-to/control-center' },
            { text: 'Test your app', link: '/how-to/testing' },
            { text: 'Use with your AI agent', link: '/how-to/ai-agents' },
          ],
        },
      ],
      // ── Concepts — understanding-oriented (the model and the why) ────────
      '/concepts/': [
        {
          text: 'Concepts',
          items: [
            { text: 'Why super-line', link: '/concepts/why-super-line' },
            { text: 'The contract model', link: '/concepts/the-contract' },
            { text: 'Server-authoritative design', link: '/concepts/server-authoritative' },
            { text: 'Transports vs. adapters', link: '/concepts/transports-and-adapters' },
            { text: 'Reconnection & delivery', link: '/concepts/reconnection-delivery' },
            { text: 'The plugin model', link: '/concepts/plugins' },
            { text: 'Auth lifecycle & sealed tokens', link: '/concepts/auth-lifecycle-sealed-tokens' },
            { text: 'Comparison & FAQ', link: '/concepts/comparison-faq' },
          ],
        },
      ],
      // ── Collections — flagship, self-contained (rows + CRDT documents) ───
      '/collections/': [
        {
          text: 'Collections',
          items: [
            { text: 'Overview: rows vs. documents', link: '/collections/' },
            { text: 'Row collections', link: '/collections/row-collections' },
            { text: 'CRDT document collections', link: '/collections/crdt-documents' },
            { text: 'Row-level security & policies', link: '/collections/policies' },
            { text: 'Querying with TanStack DB', link: '/collections/tanstack-db' },
            { text: 'Backends & clustering', link: '/collections/backends' },
          ],
        },
      ],
      // ── Plugins — curated ecosystem integrations ──────────────────────────
      '/plugins/': [
        {
          text: 'Plugins',
          items: [
            { text: 'Plugin catalog', link: '/plugins/' },
            { text: 'Authentication', link: '/how-to/plugin-auth' },
            { text: 'Auth · sessions, roles & API keys', link: '/how-to/auth-sessions-roles-keys' },
            { text: 'Auth · JWT & sealed tokens', link: '/how-to/auth-jwt-sealed-tokens' },
            { text: 'Auth · server-side hooks', link: '/how-to/auth-hooks' },
            { text: 'Auth · agent identity', link: '/how-to/auth-agent-identity' },
            { text: 'Auth · lifecycle & sealed tokens', link: '/concepts/auth-lifecycle-sealed-tokens' },
            { text: 'Chat backbone', link: '/how-to/plugin-chat' },
            { text: 'Chat · migrate 0.4 to 0.5', link: '/how-to/plugin-chat-0-5-migration' },
            { text: 'Chat · stream an agent’s turn', link: '/how-to/chat-streaming' },
            { text: 'Chat · run an AI bot', link: '/how-to/chat-bots' },
            { text: 'Chat · channel resources', link: '/how-to/chat-resources' },
            { text: 'Chat · drive from scripts', link: '/how-to/chat-headless' },
            { text: 'Control Center inspector', link: '/how-to/control-center' },
            { text: 'Super Harness', link: '/plugins/super-harness' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Cheatsheets',
          items: [
            { text: 'Contract entry shapes', link: '/reference/cheatsheets/contract-shapes' },
            { text: 'Wire frames', link: '/reference/cheatsheets/wire-frames' },
            { text: 'Error codes', link: '/reference/cheatsheets/errors' },
            { text: 'Server & client options', link: '/reference/cheatsheets/options' },
          ],
        },
        { text: 'Packages', items: typedocSidebar },
      ],
      // ── Examples — the runnable-app catalog, plus its deep-dive pages ─────
      '/examples/': [
        {
          text: 'Examples',
          items: [
            { text: 'The catalog', link: '/examples/' },
            { text: 'chat-supervisor · terminal cockpit', link: '/examples/chat-supervisor-tui' },
          ],
        },
      ],
    },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/mertdogar/super-line' }],
    editLink: {
      pattern: 'https://github.com/mertdogar/super-line/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Mert',
    },
  },
})
