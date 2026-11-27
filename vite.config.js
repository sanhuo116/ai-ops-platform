import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  root: 'src',
  base: '/aiops/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5174,
    proxy: Object.fromEntries(['/aiops/api/', '/aiops/login', '/aiops/auth/', '/aiops/planet/qr/callback', '/ga/aiops-entry'].map(p => [p, 'http://127.0.0.1:8787'])),
  },
})
