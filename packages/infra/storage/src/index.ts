import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { UserId } from '@zhizhi/brand'
import { ZhizhiError } from '@zhizhi/errors'

export interface StoredAsset {
  readonly key: string
  readonly assetUrl: string
  readonly byteLength: number
  readonly contentType: string
}

/**
 * 对象存储能力缝隙（Capability Seam）：
 * 所有对象键强制按 u/{userId}/... 进行租户隔离。
 */
export interface StorageProvider {
  readonly driver: 'local' | 's3'
  put(userId: UserId, relativeName: string, data: Uint8Array, contentType: string): Promise<StoredAsset>
  get(userId: UserId, key: string): Promise<Uint8Array>
  delete(userId: UserId, key: string): Promise<void>
}

function assertOwnedKey(userId: UserId, key: string): void {
  const prefix = `u/${userId}/`
  if (!key.startsWith(prefix) || key.includes('..')) {
    throw new ZhizhiError({
      code: 'TENANT_ISOLATION_VIOLATION',
      message: `Asset key "${key}" is outside tenant scope`,
    })
  }
}

export class LocalFsStorageProvider implements StorageProvider {
  readonly driver = 'local' as const
  private readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir)
  }

  async put(
    userId: UserId,
    relativeName: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<StoredAsset> {
    const ext = path.extname(relativeName).replace(/[^a-zA-Z0-9.]/g, '') || '.bin'
    const digest = crypto.createHash('sha256').update(data).digest('hex').slice(0, 24)
    const key = `u/${userId}/assets/${digest}${ext}`
    const fullPath = path.resolve(this.rootDir, key)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, data)
    return {
      key,
      assetUrl: `asset://${key}`,
      byteLength: data.byteLength,
      contentType,
    }
  }

  async get(userId: UserId, key: string): Promise<Uint8Array> {
    assertOwnedKey(userId, key)
    const fullPath = path.resolve(this.rootDir, key)
    try {
      const buf = await fs.readFile(fullPath)
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch (err) {
      throw new ZhizhiError({
        code: 'NOT_FOUND',
        message: `Asset not found: ${key}`,
        cause: err,
      })
    }
  }

  async delete(userId: UserId, key: string): Promise<void> {
    assertOwnedKey(userId, key)
    const fullPath = path.resolve(this.rootDir, key)
    try {
      await fs.unlink(fullPath)
    } catch (_err) {
      // Deleting an already-absent file is idempotent by design.
    }
  }
}
