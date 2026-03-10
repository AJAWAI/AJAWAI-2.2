import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/AJAWAI-2.2/',
  plugins: [react()],
  server: {
    host: true,
    port: 5173
  },
  build: {
    target: 'esnext'
  },
  optimizeDeps: {
    exclude: ['@xenova/transformers']
  }
})
