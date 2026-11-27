import fs from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite'
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import type { TenantContext } from '@zhizhi/contracts'
import * as schema from './schema.ts'
import { BOOTSTRAP_SQL } from './bootstrap-sql.ts'

export type ZhizhiDatabase = PgliteDatabase<typeof schema> | PostgresJsDatabase<typeof schema>

export interface DatabaseConfig {
  /** 为空或以 memory://、pglite:// 开头时使用嵌入式 PGlite（零 Docker）；postgres:// 时连接标准 PG */
  readonly databaseUrl?: string
  /** PGlite 落盘目录（未设 databaseUrl 时生效） */
  readonly dataDir?: string
}

export interface DatabaseHandle {
  readonly driver: 'pglite' | 'postgres'
  readonly db: ZhizhiDatabase
  bootstrap(): Promise<void>
  close(): Promise<void>
}

export async function createDatabase(config: DatabaseConfig = {}): Promise<DatabaseHandle> {
  const url = config.databaseUrl?.trim()

  if (url && (url.startsWith('postgres://') || url.startsWith('postgresql://'))) {
    const client = postgres(url, { max: 10 })
    const db = drizzlePostgres(client, { schema })
    return {
      driver: 'postgres',
      db,
      async bootstrap(): Promise<void> {
        await client.unsafe(BOOTSTRAP_SQL)
      },
      async close(): Promise<void> {
        await client.end()
      },
    }
  }

  let pglite: PGlite
  if (url === 'memory://') {
    pglite = new PGlite()
  } else {
    const dir = url?.startsWith('pglite://')
      ? url.slice('pglite://'.length)
      : path.resolve(config.dataDir ?? '.zhizhi', 'pgdata')
    fs.mkdirSync(dir, { recursive: true })
    pglite = new PGlite(dir)
  }

  await pglite.waitReady
  const db = drizzlePglite(pglite, { schema })

  return {
    driver: 'pglite',
    db,
    async bootstrap(): Promise<void> {
      await pglite.exec(BOOTSTRAP_SQL)
    },
    async close(): Promise<void> {
      await pglite.close()
    },
  }
}

/**
 * 租户隔离执行器（ADR-01）：
 * 统一在事务内设置 PostgreSQL 会话变量 app.current_user_id（供 RLS 兜底）并透传租户上下文。
 */
export async function withTenant<T>(
  handle: DatabaseHandle,
  tenant: TenantContext,
  fn: (db: ZhizhiDatabase, tenant: TenantContext) => Promise<T>,
): Promise<T> {
  await handle.db.execute(sql`SELECT set_config('app.current_user_id', ${tenant.userId}, false)`)
  return fn(handle.db, tenant)
}
