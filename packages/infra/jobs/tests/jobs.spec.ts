import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mintUserId } from '@zhizhi/brand'
import type { TenantContext } from '@zhizhi/contracts'
import { createDatabase, users, withTenant, type DatabaseHandle } from '@zhizhi/db'
import { DbJobQueue } from '@zhizhi/jobs'

describe('DbJobQueue background worker', () => {
  let dbHandle: DatabaseHandle

  beforeAll(async () => {
    dbHandle = await createDatabase({ databaseUrl: 'memory://' })
    await dbHandle.bootstrap()
  })

  afterAll(async () => {
    await dbHandle.close()
  })

  async function seedUser(role: 'user' | 'admin' = 'user'): Promise<TenantContext> {
    const tenant: TenantContext = { userId: mintUserId(), role }
    await withTenant(dbHandle, tenant, async (db) => {
      await db.insert(users).values({
        id: tenant.userId,
        email: `${tenant.userId}@zhizhi.dev`,
        displayName: 'Worker Test',
        passwordHash: 'unused',
        role,
      })
    })
    return tenant
  }

  it('consumes queued jobs across tenants via startWorker while preserving TenantContext isolation', async () => {
    const tenantA = await seedUser('user')
    const tenantB = await seedUser('admin')
    const queue = new DbJobQueue(dbHandle)

    const seen: Array<{ userId: string; role: string; tag: string }> = []
    queue.registerHandler('ingest_sub_loop', async (job, tenant, reportProgress) => {
      await reportProgress(50)
      seen.push({ userId: tenant.userId, role: tenant.role, tag: String(job.payload['tag'] ?? '') })
      return { ok: true, owner: tenant.userId }
    })

    const jobA = await queue.enqueue(tenantA, { jobType: 'ingest_sub_loop', payload: { tag: 'first' } })
    const jobB = await queue.enqueue(tenantB, { jobType: 'ingest_sub_loop', payload: { tag: 'second' } })

    const stop = queue.startWorker({ pollIntervalMs: 50 })
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3_000
        const check = async (): Promise<void> => {
          const recA = await queue.getByIdForTenant(tenantA, jobA)
          const recB = await queue.getByIdForTenant(tenantB, jobB)
          if (recA?.status === 'succeeded' && recB?.status === 'succeeded') {
            resolve()
            return
          }
          if (Date.now() > deadline) {
            reject(new Error('Timed out waiting for background worker to finish jobs'))
            return
          }
          setTimeout(() => {
            void check()
          }, 30)
        }
        void check()
      })
    } finally {
      stop()
    }

    expect(seen).toEqual([
      { userId: tenantA.userId, role: 'user', tag: 'first' },
      { userId: tenantB.userId, role: 'admin', tag: 'second' },
    ])

    const crossRead = await queue.getByIdForTenant(tenantA, jobB)
    expect(crossRead).toBeNull()
  })
})
