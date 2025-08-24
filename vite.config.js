import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// If you rename the repo, update base: '/NEW_NAME/'
export default defineConfig({
  plugins: [react()],
  base: '/wave-lab/',
  build: { outDir: 'docs' } // build straight into /docs for GitHub Pages
})
