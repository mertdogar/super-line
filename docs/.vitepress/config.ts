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
  // PRODUCT.md is an internal brief — keep the file but don't build it as an orphan page.
  srcExclude: ['PRODUCT.md'],
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
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Examples', link: '/examples/' },
      {
        text: 'Design notes',
        items: [
          {
            text: 'ADR-0001: Automerge over Yjs (superseded)',
            link: '/adr/0001-automerge-over-yjs-for-synced-scene-state',
          },
          {
            text: 'ADR-0002: Yjs via super-store',
            link: '/adr/0002-yjs-via-super-store-over-automerge',
          },
          {
            text: 'ADR-0003: Stores are off-contract & untyped',
            link: '/adr/0003-stores-are-off-contract-and-untyped',
          },
        ],
      },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Why super-line', link: '/guide/introduction' },
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'The contract', link: '/guide/the-contract' },
          ],
        },
        {
          text: 'Transports',
          items: [
            { text: 'Choose your wire', link: '/guide/transports' },
            { text: 'WebSocket', link: '/guide/transport-websocket' },
            { text: 'HTTP — SSE & long-poll', link: '/guide/transport-http' },
            { text: 'libp2p & WebRTC', link: '/guide/transport-libp2p' },
            { text: 'Loopback (testing)', link: '/guide/transport-loopback' },
          ],
        },
        {
          text: 'Interaction flavors',
          items: [
            { text: 'Requests', link: '/guide/requests' },
            { text: 'Events & rooms', link: '/guide/events-rooms' },
            { text: 'Topics', link: '/guide/topics' },
            { text: 'The cluster event bus', link: '/guide/cluster-event-bus' },
          ],
        },
        {
          text: 'Persisted state',
          items: [
            { text: 'Choosing a store', link: '/guide/choosing-a-store' },
            { text: 'Stores', link: '/guide/store' },
            { text: 'Synced state (CRDT)', link: '/guide/synced-state' },
            { text: 'Postgres + Electric (CRDT)', link: '/guide/store-sync-pglite' },
          ],
        },
        {
          text: 'Server',
          items: [
            { text: 'Roles & auth', link: '/guide/roles-auth' },
            { text: 'Middleware & lifecycle', link: '/guide/middleware-lifecycle' },
            { text: 'Error handling', link: '/guide/errors' },
            { text: 'Introspection & presence', link: '/guide/introspection-and-presence' },
            { text: 'Control Center', link: '/guide/control-center' },
          ],
        },
        {
          text: 'Client',
          items: [
            { text: 'Reconnection & delivery', link: '/guide/reconnection-delivery' },
            { text: 'Serialization', link: '/guide/serialization' },
            { text: 'React', link: '/guide/react' },
          ],
        },
        {
          text: 'Adapters',
          items: [
            { text: 'Choose your backbone', link: '/guide/scaling-adapters' },
            { text: 'Redis', link: '/guide/adapter-redis' },
            { text: 'libp2p', link: '/guide/adapter-libp2p' },
            { text: 'RabbitMQ', link: '/guide/adapter-rabbitmq' },
            { text: 'ZeroMQ', link: '/guide/adapter-zeromq' },
          ],
        },
        {
          text: 'More',
          items: [
            { text: 'Testing', link: '/guide/testing' },
            { text: 'Use with your AI agent', link: '/guide/ai-agents' },
            { text: 'Comparison & FAQ', link: '/guide/comparison-faq' },
          ],
        },
      ],
      '/reference/': [{ text: 'Packages', items: typedocSidebar }],
      '/adr/': [
        {
          text: 'Design notes (ADRs)',
          items: [
            {
              text: 'ADR-0001: Automerge over Yjs (superseded)',
              link: '/adr/0001-automerge-over-yjs-for-synced-scene-state',
            },
            {
              text: 'ADR-0002: Yjs via super-store',
              link: '/adr/0002-yjs-via-super-store-over-automerge',
            },
            {
              text: 'ADR-0003: Stores are off-contract & untyped',
              link: '/adr/0003-stores-are-off-contract-and-untyped',
            },
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
