import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import CopyOrDownloadAsMarkdownButtons from 'vitepress-plugin-llms/vitepress-components/CopyOrDownloadAsMarkdownButtons.vue'
import SuperHome from './components/SuperHome.vue'
import './styles/brand.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('SuperHome', SuperHome)
    app.component('CopyOrDownloadAsMarkdownButtons', CopyOrDownloadAsMarkdownButtons)
  },
} satisfies Theme
