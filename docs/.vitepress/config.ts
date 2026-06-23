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
  head: [['link', { rel: 'icon', href: '/mark.svg' }]],
  markdown: {
    config(md) {
      md.use(copyOrDownloadAsMarkdownButtons)
    },
  },
  vite: {
    plugins: [llmstxt({ domain: 'https://super-line.dogar.biz' })],
  },
  themeConfig: {
    logo: '/mark.svg',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Examples', link: '/examples/' },
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
            { text: 'Stores', link: '/guide/store' },
            { text: 'Synced state (CRDT)', link: '/guide/synced-state' },
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
