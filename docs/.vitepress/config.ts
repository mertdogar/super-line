import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'super-line',
  description:
    'End-to-end typesafe WebSockets for TypeScript — role-scoped contracts, req/res, rooms & topics from one contract.',
  base: '/super-line/',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
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
