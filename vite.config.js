import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages: https://surferyogi.github.io/hiyakuai/
export default defineConfig({
  plugins: [react()],
  base: '/hiyakuai/',
})
