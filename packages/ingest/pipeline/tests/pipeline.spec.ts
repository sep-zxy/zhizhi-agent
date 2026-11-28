import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPiSubLoopTask } from '@zhizhi/agent-runtime'
import { mintPluginId, mintUserId } from '@zhizhi/brand'
import type { AsrProvider, TranscriptSegment } from '@zhizhi/cap-asr'
import type { KeyframeExtractor } from '@zhizhi/cap-media-frames'
import { StandardMarkdownDocumentSchema, type TenantContext } from '@zhizhi/contracts'
import { createDatabase, todoItems, userApiKeys, users, wikiCards, withTenant, type DatabaseHandle } from '@zhizhi/db'
import { DbJobQueue } from '@zhizhi/jobs'
import {
  SourcePluginRegistry,
  type RawExtractedBundle,
  type RawIngestInput,
  type SourcePlugin,
} from '@zhizhi/plugin-sdk'
import { LocalFsStorageProvider } from '@zhizhi/storage'
import { IngestJobPayloadSchema, IngestPipelineService } from '../src/index.ts'

const textInput: RawIngestInput = { sourceType: 'web_article', rawText: '这是待整理的文章。' }
const textBundle = {
  title: '文章标题',
  originKind: 'web',
  originLabel: '文章测试站',
  originUrl: 'https://example.com/article',
  anchors: [],
  rawBody: '先理解概念，再进行应用。',
  candidateTopics: ['学习'],
} satisfies RawExtractedBundle
const videoInput: RawIngestInput = {
  sourceType: 'video_note',
  url: 'https://example.com/video',
  metadata: { author: '视频作者' },
}
const videoBundle = {
  title: '视频标题',
  originKind: 'video',
  originLabel: '视频测试站',
  originUrl: 'https://example.com/video',
  anchors: ['00:02'],
  rawBody: '这是视频简介。',
  mediaRef: { kind: 'video', remoteUrl: 'https://example.com/video.mp4', durationSec: 20 },
  fallbackCoverUrl: 'https://example.com/cover.jpg',
  needsAsr: true,
  needsKeyframes: true,
} satisfies RawExtractedBundle
const fauxRoute = { provider: 'zhizhi-faux', modelId: 'zhizhi-dev-mock' }
const imageBytes = Uint8Array.of(10, 20, 30)

function createPlugin(overrides: Partial<SourcePlugin> = {}): SourcePlugin {
  return {
    pluginId: mintPluginId('test-source'),
    displayName: '测试来源插件',
    mode: 'in_process',
    supportedTypes: ['web_article'],
    needsSubLoop: false,
    async healthcheck() {
      return { ok: true }
    },
    async preflight() {
      return { requiresSubLoop: false, estimatedChars: textBundle.rawBody.length }
    },
    async extract() {
      return textBundle
    },
    ...overrides,
  }
}

describe('IngestJobPayloadSchema', () => {
  it('defaults to archiving, strips untrusted tenant data and validates job options', () => {
    expect(IngestJobPayloadSchema.parse({
      tenant: { userId: 'ignored' },
      input: { ...textInput, userId: 'ignored' },
    })).toEqual({ input: textInput, disposition: 'archive_only' })
    expect(IngestJobPayloadSchema.safeParse({ input: { sourceType: 'unsupported' } }).success).toBe(false)
    expect(IngestJobPayloadSchema.safeParse({ input: textInput, maxKeyframes: 0 }).success).toBe(false)
    expect(IngestJobPayloadSchema.safeParse({ input: textInput, pluginId: ' ' }).success).toBe(false)
    expect(IngestJobPayloadSchema.safeParse({ input: textInput, disposition: 'publish' }).success).toBe(false)
  })
})

describe('IngestPipelineService', () => {
  let rootDir: string
  let dbHandle: DatabaseHandle
  let storage: LocalFsStorageProvider
  let tenant: TenantContext
  let otherTenant: TenantContext
  let plugins: SourcePluginRegistry

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'zhizhi-ingest-'))
    dbHandle = await createDatabase({ databaseUrl: 'memory://', dataDir: rootDir })
    await dbHandle.bootstrap()
    storage = new LocalFsStorageProvider(rootDir)
  }, 15_000)

  afterAll(async () => {
    try {
      await dbHandle?.close()
    } finally {
      if (rootDir) await rm(rootDir, { recursive: true, force: true })
    }
  })

  beforeEach(async () => {
    tenant = { userId: mintUserId(), role: 'user' }
    otherTenant = { userId: mintUserId(), role: 'user' }
    for (const ctx of [tenant, otherTenant]) {
      await withTenant(dbHandle, ctx, async (db) => {
        await db.insert(users).values({
          id: ctx.userId,
          email: `${ctx.userId}@example.com`,
          displayName: '测试用户',
          passwordHash: 'unused',
        })
      })
    }
    plugins = new SourcePluginRegistry()
  })

  it('补齐字幕和关键帧，落盘后走真实 Pi faux 子循环并写入标准文档', async () => {
    const segments: TranscriptSegment[] = [{ startSec: 2, endSec: 5, text: '先理解基础概念。' }]
    const asr: AsrProvider = {
      providerId: 'test-asr',
      supportsTimestamps: true,
      healthcheck: vi.fn(async () => ({ ok: true })),
      transcribe: vi.fn(async () => ({ providerId: 'test-asr', fullText: '先理解基础概念。', segments })),
    }
    const keyframes: KeyframeExtractor = {
      async healthcheck() {
        return { ok: true }
      },
      extractKeyframes: vi.fn<KeyframeExtractor['extractKeyframes']>(async () => [{
        name: 'frame.jpg',
        contentType: 'image/jpeg',
        data: imageBytes,
        caption: '概念图',
        timestampSec: 2,
        strategy: 'L1_timestamp',
      }]),
    }
    const signal = new AbortController().signal
    const onProgress = vi.fn()
    const preflight = vi.fn(async () => ({ requiresSubLoop: true, estimatedChars: 80, warningMessage: '估算提示' }))
    const extract = vi.fn(async () => videoBundle)
    plugins.register(createPlugin({ supportedTypes: ['video_note'], needsSubLoop: true, preflight, extract }))
    const subLoopRunner = vi.fn<typeof runPiSubLoopTask>(async (params) => {
      expect(params.userPrompt).toContain('视频作者')
      expect(params.userPrompt).toContain(videoBundle.originLabel)
      const assetKey = params.userPrompt.match(/asset:\/\/(u\/[^)]+)\)/)?.[1]
      if (!assetKey) throw new Error('解析子循环未收到已落盘的关键帧引用')
      expect(await storage.get(tenant.userId, assetKey)).toEqual(imageBytes)
      return runPiSubLoopTask(params)
    })
    const service = new IngestPipelineService({
      dbHandle,
      storage,
      plugins,
      asr,
      keyframes,
      subLoopRunner,
      defaultSubLoopModelRoute: fauxRoute,
    })

    const result = await service.run({ tenant, input: videoInput, disposition: 'archive_only', signal, onProgress, maxKeyframes: 2 })

    expect(preflight).toHaveBeenCalledWith(videoInput, tenant)
    expect(extract).toHaveBeenCalledWith(videoInput, tenant, { signal, onProgress, capabilities: { asr, keyframes } })
    expect(asr.healthcheck).toHaveBeenCalledOnce()
    expect(asr.transcribe).toHaveBeenCalledWith({ media: videoBundle.mediaRef, signal })
    expect(keyframes.extractKeyframes).toHaveBeenCalledWith({
      media: videoBundle.mediaRef,
      transcript: segments,
      fallbackCoverUrl: videoBundle.fallbackCoverUrl,
      maxFrames: 2,
      signal,
    })
    const subLoopCall = subLoopRunner.mock.calls[0]?.[0]
    expect(subLoopCall?.modelRoute).toEqual(fauxRoute)
    expect(subLoopCall?.userPrompt).toContain('[00:02–00:05] 先理解基础概念。')
    expect(result.warnings).toEqual(['估算提示'])
    expect(StandardMarkdownDocumentSchema.safeParse(result.document).success).toBe(true)
    expect(result.document.frontmatter.parseTrace.subLoopModel).toBe(fauxRoute.modelId)
    const [asset] = result.document.frontmatter.assets
    expect(asset).toMatchObject({ caption: '概念图', timestampSec: 2 })
    if (!asset) throw new Error('未保存关键帧')
    expect(asset.url).toBe(`asset://${asset.id}`)
    expect(asset.id).toMatch(new RegExp(`^u/${tenant.userId}/assets/[^/]+\\.jpg$`))
    expect(await readFile(join(rootDir, asset.id))).toEqual(Buffer.from(imageBytes))
    const persisted = await service.getSourceByTenant(tenant, result.sourceId)
    expect(persisted).toMatchObject({
      id: result.sourceId,
      userId: tenant.userId,
      frontmatterJson: result.document.frontmatter,
      standardMarkdown: result.document.bodyMarkdown,
    })
    expect(persisted?.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('ASR 不可用时保留原文，仍可将无字幕媒体交给关键帧兜底', async () => {
    plugins.register(createPlugin({ supportedTypes: ['video_note'], async extract() { return videoBundle } }))
    const keyframes: KeyframeExtractor = {
      async healthcheck() {
        return { ok: true }
      },
      extractKeyframes: vi.fn(async () => []),
    }
    const subLoopRunner = vi.fn<typeof runPiSubLoopTask>()
    const service = new IngestPipelineService({ dbHandle, storage, plugins, keyframes, subLoopRunner })

    const result = await service.run({ tenant, input: videoInput, disposition: 'archive_only' })

    expect(result.warnings).toEqual([expect.stringContaining('ASR')])
    expect(result.document.bodyMarkdown).toContain(videoBundle.rawBody)
    expect(keyframes.extractKeyframes).toHaveBeenCalledWith({
      media: videoBundle.mediaRef,
      fallbackCoverUrl: videoBundle.fallbackCoverUrl,
    })
    expect(subLoopRunner).not.toHaveBeenCalled()
  })

  it('ASR 执行失败时降级，但取消转写时不继续写入来源', async () => {
    const controller = new AbortController()
    const cancelled = new Error('采集已取消')
    const asr: AsrProvider = {
      providerId: 'test-asr',
      supportsTimestamps: true,
      async healthcheck() {
        return { ok: true }
      },
      async transcribe({ signal }) {
        if (signal === controller.signal) controller.abort(cancelled)
        throw new Error('ASR 暂不可用')
      },
    }
    plugins.register(createPlugin({
      supportedTypes: ['video_note'],
      async extract() {
        return { ...videoBundle, needsKeyframes: false }
      },
    }))
    const service = new IngestPipelineService({ dbHandle, storage, plugins, asr })

    const degraded = await service.run({ tenant, input: videoInput, disposition: 'archive_only' })
    expect(degraded.document.bodyMarkdown).toContain(videoBundle.rawBody)
    expect(degraded.warnings).toEqual([expect.stringContaining('ASR 转写失败')])

    await expect(service.run({ tenant: otherTenant, input: videoInput, disposition: 'archive_only', signal: controller.signal }))
      .rejects.toBe(cancelled)
    expect(await service.listSourcesByTenant(otherTenant)).toEqual([])
  })

  it('来源写入按租户与内容幂等，待学不重复追加，知识卡仅返回待保存草稿', async () => {
    plugins.register(createPlugin())
    const service = new IngestPipelineService({ dbHandle, storage, plugins })

    const queued = await service.run({ tenant, input: textInput, disposition: 'todo_queue' })
    const repeated = await service.run({ tenant, input: textInput, disposition: 'todo_queue' })
    const draft = await service.run({ tenant, input: textInput, disposition: 'wiki_card' })
    const other = await service.run({ tenant: otherTenant, input: textInput, disposition: 'archive_only' })
    const firstRow = await service.getSourceByTenant(tenant, queued.sourceId)
    const otherRow = await service.getSourceByTenant(otherTenant, other.sourceId)

    expect(other.sourceId).not.toBe(queued.sourceId)
    expect(otherRow?.contentHash).toBe(firstRow?.contentHash)
    expect(repeated.sourceId).toBe(queued.sourceId)
    expect(draft.wikiCardDraft).toEqual({
      title: textBundle.title,
      bodyMarkdown: draft.document.bodyMarkdown,
      sourceId: queued.sourceId,
      requiresUserSave: true,
    })
    expect(draft.document.frontmatter.sourceId).toBe(queued.sourceId)
    expect(await service.listSourcesByTenant(tenant)).toEqual([expect.objectContaining({
      id: queued.sourceId,
      disposition: 'wiki_card',
      frontmatterJson: draft.document.frontmatter,
    })])
    await withTenant(dbHandle, tenant, async (db) => {
      const todos = await db.select().from(todoItems).where(eq(todoItems.userId, tenant.userId))
      expect(todos).toEqual([expect.objectContaining({ sourceId: queued.sourceId, title: textBundle.title, status: 'pending' })])
      const cards = await db.select().from(wikiCards).where(eq(wikiCards.userId, tenant.userId))
      expect(cards).toEqual([])
    })
  })

  it('队列使用已认证租户、上报中间进度，并在任务成功后写入 100', async () => {
    const jobs = new DbJobQueue(dbHandle)
    const plugin = createPlugin({
      pluginId: mintPluginId('explicit-plugin'),
      match: () => false,
      async extract(_input, ctx, runtime) {
        expect(ctx).toEqual(tenant)
        await runtime?.onProgress?.('fetching_meta', 25)
        const [running] = await jobs.listByTenant(tenant)
        expect(running).toMatchObject({ status: 'running', progress: 25 })
        return textBundle
      },
    })
    plugins.register(plugin)
    const service = new IngestPipelineService({ dbHandle, storage, plugins })
    const dispose = service.registerJobHandler(jobs)
    try {
      const id = await jobs.enqueue(tenant, {
        jobType: 'ingest_sub_loop',
        payload: { input: textInput, pluginId: plugin.pluginId, tenant: otherTenant },
      })
      expect(await jobs.runNextForTenant(otherTenant)).toBeNull()
      const run = await jobs.runNextForTenant(tenant)
      expect(run).toMatchObject({ id, status: 'succeeded', progress: 100 })
      const [source] = await service.listSourcesByTenant(tenant)
      expect(source).toMatchObject({ pluginId: plugin.pluginId, disposition: 'archive_only' })
      const [persistedJob] = await jobs.listByTenant(tenant)
      expect(persistedJob).toMatchObject({
        id,
        status: 'succeeded',
        progress: 100,
      })
      expect(persistedJob?.result?.['sourceId']).toBe(source?.id)
      const invalidId = await jobs.enqueue(tenant, {
        jobType: 'ingest_sub_loop',
        payload: { input: { sourceType: 'unsupported' } },
        maxAttempts: 1,
      })
      expect(await jobs.runNextForTenant(tenant)).toMatchObject({
        id: invalidId,
        status: 'failed',
        errorText: 'Invalid ingest job payload',
      })
    } finally {
      dispose()
    }
  })

  it('按用户及场景选择模型配置，未配置的租户使用默认路由', async () => {
    plugins.register(createPlugin({ needsSubLoop: true }))
    const subLoopRunner = vi.fn<typeof runPiSubLoopTask>(async () => ({
      text: '```markdown\n# 整理结果\n```',
      modelId: 'test-model',
      provider: 'test-provider',
      tokensUsed: 12,
      isFaux: true,
    }))
    await withTenant(dbHandle, tenant, async (db) => {
      await db.insert(userApiKeys).values([
        {
          id: `${tenant.userId}-main`,
          userId: tenant.userId,
          scene: 'main_loop',
          provider: 'ignored',
          modelId: 'ignored',
          encryptedSecret: 'ignored',
        },
        {
          id: `${tenant.userId}-sub`,
          userId: tenant.userId,
          scene: 'sub_loop',
          provider: 'test-provider',
          modelId: 'test-model',
          baseUrl: 'https://example.com/v1',
          encryptedSecret: 'test-key',
        },
      ])
    })
    const service = new IngestPipelineService({ dbHandle, storage, plugins, subLoopRunner, defaultSubLoopModelRoute: fauxRoute })

    const result = await service.run({ tenant, input: textInput, disposition: 'archive_only' })
    await service.run({ tenant: otherTenant, input: textInput, disposition: 'archive_only' })

    expect(subLoopRunner).toHaveBeenNthCalledWith(1, expect.objectContaining({
      modelRoute: { provider: 'test-provider', modelId: 'test-model', baseUrl: 'https://example.com/v1', apiKey: 'test-key' },
    }))
    expect(subLoopRunner).toHaveBeenNthCalledWith(2, expect.objectContaining({ modelRoute: fauxRoute }))
    expect(result.document.bodyMarkdown).toBe('# 整理结果')
    expect(result.document.frontmatter.parseTrace).toMatchObject({ subLoopModel: 'test-model', tokensUsed: 12 })
    expect(JSON.stringify(result)).not.toContain('test-key')
  })

  it('双租户不可跨读来源和资产，同内容可在不同租户各自归档', async () => {
    plugins.register(createPlugin({
      async extract() {
        return { ...textBundle, binaryAssets: [{ name: 'image.png', contentType: 'image/png', data: imageBytes }] }
      },
    }))
    const service = new IngestPipelineService({ dbHandle, storage, plugins })
    const first = await service.run({ tenant, input: textInput, disposition: 'archive_only' })
    const [asset] = first.document.frontmatter.assets
    if (!asset) throw new Error('未保存图文附件')

    expect(first.document.bodyMarkdown).toContain(asset.url)
    expect(await service.listSourcesByTenant(otherTenant)).toEqual([])
    expect(await service.getSourceByTenant(otherTenant, first.sourceId)).toBeNull()
    expect(await storage.get(tenant.userId, asset.id)).toEqual(imageBytes)
    await expect(storage.get(otherTenant.userId, asset.id)).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' })

    const second = await service.run({ tenant: otherTenant, input: textInput, disposition: 'archive_only' })
    expect(second.sourceId).not.toBe(first.sourceId)
    expect(second.document.frontmatter.assets[0]?.id).toMatch(new RegExp(`^u/${otherTenant.userId}/assets/`))
    expect(await service.getSourceByTenant(tenant, second.sourceId)).toBeNull()
  })

  it('拒绝不符合标准文档 Schema 的结果，且不写入来源', async () => {
    plugins.register(createPlugin({ needsSubLoop: true }))
    const subLoopRunner = vi.fn<typeof runPiSubLoopTask>(async () => ({
      text: '  ',
      modelId: 'test-model',
      provider: 'test-provider',
      tokensUsed: 0,
      isFaux: true,
    }))
    const service = new IngestPipelineService({ dbHandle, storage, plugins, subLoopRunner })

    await expect(service.run({ tenant, input: textInput, disposition: 'todo_queue' }))
      .rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    expect(await service.listSourcesByTenant(tenant)).toEqual([])
  })
})
