import path from 'node:path'
import { serve } from '@hono/node-server'
import { createDatabase } from '@zhizhi/db'
import { LocalFsStorageProvider } from '@zhizhi/storage'
import { createDefaultDependencies, createServerApp } from './app.ts'

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? '3080')
  const host = process.env['HOST'] ?? '127.0.0.1'
  const dataDir = process.env['ZHIZHI_DATA_DIR'] ?? '.zhizhi'
  const jwtSecret = process.env['ZHIZHI_JWT_SECRET'] ?? 'dev-only-change-me-in-production-32bytes'
  const databaseUrl = process.env['DATABASE_URL']

  const dbHandle = await createDatabase({
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
    dataDir,
  })
  await dbHandle.bootstrap()

  const storage = new LocalFsStorageProvider(path.resolve(dataDir, 'storage'))
  const deps = createDefaultDependencies(dbHandle, storage, jwtSecret)
  const app = createServerApp(deps)

  const jobPollMs = Number(process.env['ZHIZHI_JOB_POLL_MS'] ?? '1000')
  const stopWorker = deps.jobs.startWorker({
    pollIntervalMs: Number.isFinite(jobPollMs) && jobPollMs >= 50 ? jobPollMs : 1_000,
    onError(err) {
      console.error('[zhizhi-worker] background job error:', err)
    },
  })

  const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(
      `[zhizhi-server] listening on http://${info.address}:${info.port} `
      + `(db=${dbHandle.driver}, storage=${storage.driver}, worker=enabled)`,
    )
  })

  const shutdown = (): void => {
    stopWorker()
    server.close()
    void dbHandle.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

void main()
