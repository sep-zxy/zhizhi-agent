import { and, asc, eq } from 'drizzle-orm'
import { asBrand, mintJobId, type JobId, type UserId } from '@zhizhi/brand'
import type { TenantContext } from '@zhizhi/contracts'
import { asyncJobs, users, withTenant, type DatabaseHandle } from '@zhizhi/db'
import { ZhizhiError } from '@zhizhi/errors'

export type ZhizhiJobType =
  | 'ingest_sub_loop'
  | 'card_auto_quiz'
  | 'card_diff_quiz'

export interface EnqueueJobInput {
  readonly jobType: ZhizhiJobType
  readonly payload: Record<string, unknown>
  readonly dedupeKey?: string
  readonly maxAttempts?: number
}

export interface JobRecord {
  readonly id: JobId
  readonly jobType: ZhizhiJobType
  readonly status: string
  readonly progress: number
  readonly payload: Record<string, unknown>
  readonly result: Record<string, unknown> | null
  readonly errorText: string | null
  readonly attempts: number
}

export type JobHandler = (
  job: JobRecord,
  tenant: TenantContext,
  reportProgress: (percent: number) => Promise<void>,
) => Promise<Record<string, unknown>>

export interface JobWorkerOptions {
  readonly pollIntervalMs?: number
  readonly onError?: (err: unknown) => void
}

/**
 * 基于 async_jobs 表的轻量持久化异步队列（V1 零 Redis 依赖，重启不丢任务）。
 * 承载：AI 解析子循环、知识卡入库默认 2 道选择题、补卡/改卡判重增量出题。
 */
export class DbJobQueue {
  private readonly handlers = new Map<ZhizhiJobType, JobHandler>()
  private readonly dbHandle: DatabaseHandle

  constructor(dbHandle: DatabaseHandle) {
    this.dbHandle = dbHandle
  }

  registerHandler(jobType: ZhizhiJobType, handler: JobHandler): () => void {
    this.handlers.set(jobType, handler)
    return () => {
      if (this.handlers.get(jobType) === handler) {
        this.handlers.delete(jobType)
      }
    }
  }

  async enqueue(tenant: TenantContext, input: EnqueueJobInput): Promise<JobId> {
    return withTenant(this.dbHandle, tenant, async (db) => {
      if (input.dedupeKey) {
        const existing = await db
          .select({ id: asyncJobs.id })
          .from(asyncJobs)
          .where(and(eq(asyncJobs.userId, tenant.userId), eq(asyncJobs.dedupeKey, input.dedupeKey)))
          .limit(1)
        const hit = existing[0]
        if (hit) {
          return asBrand<JobId>(hit.id)
        }
      }

      const id = mintJobId()
      await db.insert(asyncJobs).values({
        id,
        userId: tenant.userId,
        jobType: input.jobType,
        dedupeKey: input.dedupeKey ?? null,
        status: 'queued',
        progress: 0,
        payloadJson: input.payload,
        maxAttempts: input.maxAttempts ?? 3,
      })
      return id
    })
  }

  async listByTenant(tenant: TenantContext): Promise<JobRecord[]> {
    return withTenant(this.dbHandle, tenant, async (db) => {
      const rows = await db
        .select()
        .from(asyncJobs)
        .where(eq(asyncJobs.userId, tenant.userId))
        .orderBy(asc(asyncJobs.createdAt))

      return rows.map(row => ({
        id: asBrand<JobId>(row.id),
        jobType: row.jobType as ZhizhiJobType,
        status: row.status,
        progress: row.progress,
        payload: row.payloadJson as Record<string, unknown>,
        result: (row.resultJson as Record<string, unknown> | null) ?? null,
        errorText: row.errorText,
        attempts: row.attempts,
      }))
    })
  }

  async getByIdForTenant(tenant: TenantContext, jobId: JobId): Promise<JobRecord | null> {
    return withTenant(this.dbHandle, tenant, async (db) => {
      const rows = await db
        .select()
        .from(asyncJobs)
        .where(and(eq(asyncJobs.userId, tenant.userId), eq(asyncJobs.id, jobId)))
        .limit(1)
      const row = rows[0]
      if (!row) return null
      return {
        id: asBrand<JobId>(row.id),
        jobType: row.jobType as ZhizhiJobType,
        status: row.status,
        progress: row.progress,
        payload: row.payloadJson as Record<string, unknown>,
        result: (row.resultJson as Record<string, unknown> | null) ?? null,
        errorText: row.errorText,
        attempts: row.attempts,
      }
    })
  }

  /**
   * 消费当前租户的一条待执行任务（便于同步测试与后台 Worker 轮询共用）。
   */
  async runNextForTenant(tenant: TenantContext): Promise<JobRecord | null> {
    const picked = await withTenant(this.dbHandle, tenant, async (db) => {
      const rows = await db
        .select()
        .from(asyncJobs)
        .where(and(eq(asyncJobs.userId, tenant.userId), eq(asyncJobs.status, 'queued')))
        .orderBy(asc(asyncJobs.createdAt))
        .limit(1)
      const row = rows[0]
      if (!row) return null

      await db
        .update(asyncJobs)
        .set({ status: 'running', attempts: row.attempts + 1, updatedAt: new Date() })
        .where(and(eq(asyncJobs.id, row.id), eq(asyncJobs.userId, tenant.userId)))

      return {
        id: asBrand<JobId>(row.id),
        jobType: row.jobType as ZhizhiJobType,
        status: 'running',
        progress: row.progress,
        payload: row.payloadJson as Record<string, unknown>,
        result: null,
        errorText: null,
        attempts: row.attempts + 1,
        maxAttempts: row.maxAttempts,
      }
    })

    if (!picked) return null

    const handler = this.handlers.get(picked.jobType)
    if (!handler) {
      const errMsg = `No handler registered for job type "${picked.jobType}"`
      await withTenant(this.dbHandle, tenant, async (db) => {
        await db
          .update(asyncJobs)
          .set({ status: 'failed', errorText: errMsg, updatedAt: new Date() })
          .where(and(eq(asyncJobs.id, picked.id), eq(asyncJobs.userId, tenant.userId)))
      })
      throw new ZhizhiError({ code: 'JOB_FAILED', message: errMsg })
    }

    try {
      const result = await handler(picked, tenant, async (percent) => {
        const clamped = Math.max(0, Math.min(100, Math.round(percent)))
        await withTenant(this.dbHandle, tenant, async (db) => {
          await db
            .update(asyncJobs)
            .set({ progress: clamped, updatedAt: new Date() })
            .where(and(eq(asyncJobs.id, picked.id), eq(asyncJobs.userId, tenant.userId)))
        })
      })

      await withTenant(this.dbHandle, tenant, async (db) => {
        await db
          .update(asyncJobs)
          .set({ status: 'succeeded', progress: 100, resultJson: result, errorText: null, updatedAt: new Date() })
          .where(and(eq(asyncJobs.id, picked.id), eq(asyncJobs.userId, tenant.userId)))
      })
      return { ...picked, status: 'succeeded', progress: 100, result }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const nextStatus = picked.attempts < picked.maxAttempts ? 'queued' : 'failed'
      await withTenant(this.dbHandle, tenant, async (db) => {
        await db
          .update(asyncJobs)
          .set({ status: nextStatus, errorText: message, updatedAt: new Date() })
          .where(and(eq(asyncJobs.id, picked.id), eq(asyncJobs.userId, tenant.userId)))
      })
      return { ...picked, status: nextStatus, errorText: message }
    }
  }

  /**
   * 后台 Worker 单步调度：按入队时间捞取最早一条 queued 任务的所属租户，
   * 构造完整 TenantContext 后完全委托给 `runNextForTenant()` 在租户隔离内执行。
   */
  async runNextPending(): Promise<JobRecord | null> {
    const queued = await this.dbHandle.db
      .select({ userId: asyncJobs.userId })
      .from(asyncJobs)
      .where(eq(asyncJobs.status, 'queued'))
      .orderBy(asc(asyncJobs.createdAt))
      .limit(1)

    const nextRow = queued[0]
    if (!nextRow) return null

    const userId = asBrand<UserId>(nextRow.userId)
    const userRows = await this.dbHandle.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    const role: TenantContext['role'] = userRows[0]?.role === 'admin' ? 'admin' : 'user'

    return this.runNextForTenant({ userId, role })
  }

  /**
   * 启动进程内轻量后台 Worker 轮询循环，返回 disposer 用于优雅停机。
   * 串行非重入调度，兼容嵌入式 PGlite 与 PostgreSQL，零额外队列中间件依赖。
   */
  startWorker(options: JobWorkerOptions = {}): () => void {
    const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1_000)
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = (delayMs: number): void => {
      if (stopped) return
      timer = setTimeout(() => {
        void tick()
      }, delayMs)
      timer.unref?.()
    }

    const tick = async (): Promise<void> => {
      if (stopped) return
      let ranJob = false
      try {
        const processed = await this.runNextPending()
        ranJob = processed !== null
      } catch (err) {
        options.onError?.(err)
      }
      schedule(ranJob ? 10 : pollIntervalMs)
    }

    schedule(pollIntervalMs)

    return () => {
      stopped = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    }
  }
}
