import { defineConfig } from 'vitest/config'
import { sharedAlias } from './vitest.config.ts'

export default defineConfig({
  resolve: {
    alias: sharedAlias,
  },
  test: {
    include: [
      'packages/*/*/tests/**/*.integration.spec.ts',
      'apps/*/tests/**/*.integration.spec.ts',
    ],
    environment: 'node',
    testTimeout: 30_000,
  },
})
