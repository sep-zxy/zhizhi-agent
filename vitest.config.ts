import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))

export const sharedAlias = {
  '@zhizhi/brand': path.resolve(root, 'packages/shared/brand/src/index.ts'),
  '@zhizhi/errors': path.resolve(root, 'packages/shared/errors/src/index.ts'),
  '@zhizhi/contracts': path.resolve(root, 'packages/shared/contracts/src/index.ts'),
  '@zhizhi/db': path.resolve(root, 'packages/infra/db/src/index.ts'),
  '@zhizhi/storage': path.resolve(root, 'packages/infra/storage/src/index.ts'),
  '@zhizhi/jobs': path.resolve(root, 'packages/infra/jobs/src/index.ts'),
  '@zhizhi/plugin-sdk': path.resolve(root, 'packages/ingest/plugin-sdk/src/index.ts'),
  '@zhizhi/agent-runtime': path.resolve(root, 'packages/agent/runtime/src/index.ts'),
  '@zhizhi/client-core': path.resolve(root, 'packages/client/core/src/index.ts'),
}

export default defineConfig({
  resolve: {
    alias: sharedAlias,
  },
  test: {
    include: [
      'packages/*/*/tests/**/*.spec.ts',
      'apps/*/tests/**/*.spec.ts',
      'scripts/**/*.spec.ts',
    ],
    exclude: [
      '**/*.integration.spec.ts',
      '**/*.e2e.spec.ts',
      '**/node_modules/**',
    ],
    environment: 'node',
  },
})
