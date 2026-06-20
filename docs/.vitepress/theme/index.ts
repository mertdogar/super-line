import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import SuperHome from './components/SuperHome.vue'
import './styles/brand.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('SuperHome', SuperHome)
  },
} satisfies Theme
