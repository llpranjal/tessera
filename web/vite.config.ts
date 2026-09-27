import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development the Rust server runs on :8787; Vite proxies API and WebSocket traffic to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
})
