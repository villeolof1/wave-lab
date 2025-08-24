import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 👇 important for project pages at https://<user>.github.io/<repo>/
  base: '/wave-lab/',
  // 👇 build straight into /docs so Pages can serve it
  build: { outDir: 'docs', emptyOutDir: true }
})
