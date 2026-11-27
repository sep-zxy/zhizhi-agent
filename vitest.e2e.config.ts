import { defineConfig } from 'vitest/config'
import { sharedAlias } from './vitest.config.ts'

export default defineConfig({
  resolve: {
    alias: sharedAlias,
  },
  test: {
    include: [
      'packages/*/*/tests/**/*.e2e.spec.ts',
      'apps/*/tests/**/*.e2e.spec.ts',
    ],
    environment: 'node',
    testTimeout: 60_000,
  },
})
