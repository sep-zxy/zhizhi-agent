import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@zhizhi/brand': path.resolve(rootDir, 'packages/shared/brand/src/index.ts'),
      '@zhizhi/errors': path.resolve(rootDir, 'packages/shared/errors/src/index.ts'),
      '@zhizhi/contracts': path.resolve(rootDir, 'packages/shared/contracts/src/index.ts'),
      '@zhizhi/client-core': path.resolve(rootDir, 'packages/client/core/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3080',
    },
  },
})
