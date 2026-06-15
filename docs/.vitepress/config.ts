import { defineConfig } from 'vitepress'
import typedocSidebar from '../reference/typedoc-sidebar.json'

export default defineConfig({
  title: 'super-line',
  description:
    'End-to-end typesafe WebSockets for TypeScript — role-scoped contracts, req/res, rooms & topics from one contract.',
  base: '/super-line/',
  cleanUrls: true,
  lastUpdated: true,
  head: [['link', { rel: 'icon', href: '/super-line/mark.svg' }]],
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
          text: 'Interaction flavors',
          items: [
            { text: 'Requests', link: '/guide/requests' },
            { text: 'Events & rooms', link: '/guide/events-rooms' },
            { text: 'Topics', link: '/guide/topics' },
          ],
        },
        {
          text: 'Server',
          items: [
            { text: 'Roles & auth', link: '/guide/roles-auth' },
            { text: 'Middleware & lifecycle', link: '/guide/middleware-lifecycle' },
            { text: 'Error handling', link: '/guide/errors' },
            { text: 'Introspection & presence', link: '/guide/introspection-and-presence' },
          ],
        },
        {
          text: 'Client',
          items: [
            { text: 'Reconnection & delivery', link: '/guide/reconnection-delivery' },
            { text: 'Serialization', link: '/guide/serialization' },
          ],
        },
        {
          text: 'Scaling & integrations',
          items: [
            { text: 'Scaling & adapters', link: '/guide/scaling-adapters' },
            { text: 'React', link: '/guide/react' },
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
