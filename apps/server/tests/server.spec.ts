import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { JobId, PluginId, UserId } from '@zhizhi/brand'
import { StandardMarkdownDocumentSchema } from '@zhizhi/contracts'
import { createDatabase, type DatabaseHandle } from '@zhizhi/db'
import { IngestPipelineService, type IngestPipelineResult, type IngestSourceRecord } from '@zhizhi/ingest-pipeline'
import { DbJobQueue, type JobRecord } from '@zhizhi/jobs'
import { createDouyinPlugin, DOUYIN_PLUGIN_ID } from '@zhizhi/plugin-douyin'
import { SourcePluginRegistry, type SourcePluginHealthReport } from '@zhizhi/plugin-sdk'
import { LocalFsStorageProvider } from '@zhizhi/storage'
import { createDefaultDependencies, createServerApp } from '../src/app.ts'

describe('server foundation: multi-tenant auth, canvas memory, SSE turn & jobs', () => {
  let dbHandle: DatabaseHandle
  let tempStorageDir: string
  let app: ReturnType<typeof createServerApp>

  beforeAll(async () => {
    dbHandle = await createDatabase({ databaseUrl: 'memory://' })
    await dbHandle.bootstrap()
    tempStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhizhi-test-storage-'))
    const storage = new LocalFsStorageProvider(tempStorageDir)
    const deps = createDefaultDependencies(dbHandle, storage, 'test-secret-key-32-bytes-minimum!!', {})
    app = createServerApp(deps)
  })

  afterAll(async () => {
    await dbHandle.close()
    await fs.rm(tempStorageDir, { recursive: true, force: true })
  })

  it('returns healthy status with pglite driver and pi-agent runtime', async () => {
    const res = await app.request('/api/v1/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; dbDriver: string; agentRuntime: { piAgentAvailable: boolean } }
    expect(body.status).toBe('ok')
    expect(body.dbDriver).toBe('pglite')
    expect(body.agentRuntime.piAgentAvailable).toBe(true)
  })

  it('enforces strict tenant isolation between two registered users', async () => {
    const regA = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@zhizhi.dev', displayName: 'Alice', password: 'password123' }),
    })
    expect(regA.status).toBe(201)
    const tokenA = ((await regA.json()) as { accessToken: string }).accessToken

    const regB = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bob@zhizhi.dev', displayName: 'Bob', password: 'password123' }),
    })
    expect(regB.status).toBe(201)
    const tokenB = ((await regB.json()) as { accessToken: string }).accessToken

    // Alice saves her pinned slot on chat_qa scene
    const saveRes = await app.request('/api/v1/canvas-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        pageScene: 'chat_qa',
        sessionId: 'default',
        slots: [
          {
            slotId: 'slot_a',
            cardType: 'wiki_card_viewer',
            title: 'Alice Private Card',
            isPinned: true,
            payload: {},
            updatedAt: '2026-11-27T00:00:00.000Z',
          },
        ],
      }),
    })
    expect(saveRes.status).toBe(200)

    // Alice reads back her state
    const getA = await app.request('/api/v1/canvas-state?pageScene=chat_qa', {
      headers: { authorization: `Bearer ${tokenA}` },
    })
    const bodyA = (await getA.json()) as { slots: Array<{ title: string }> }
    expect(bodyA.slots).toHaveLength(1)
    expect(bodyA.slots[0]?.title).toBe('Alice Private Card')

    // Bob sees an empty canvas (strict tenant isolation)
    const getB = await app.request('/api/v1/canvas-state?pageScene=chat_qa', {
      headers: { authorization: `Bearer ${tokenB}` },
    })
    const bodyB = (await getB.json()) as { slots: unknown[] }
    expect(bodyB.slots).toEqual([])
  })

  it('streams a full Pi Agent Core turn over SSE on /api/v1/chat/turn', async () => {
    const reg = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'charlie@zhizhi.dev', displayName: 'Charlie', password: 'password123' }),
    })
    const token = ((await reg.json()) as { accessToken: string }).accessToken

    const turnRes = await app.request('/api/v1/chat/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        pageScene: 'chat_qa',
        message: '给我出一道选择题',
        switches: {
          skillGenCard: false,
          quizTools: { mcq: true, tf: false, blank: false, qa: false },
        },
        pinnedSlotIds: ['slot_a'],
      }),
    })
    expect(turnRes.status).toBe(200)
    const sseBody = await turnRes.text()
    expect(sseBody).toContain('"type":"tool_start"')
    expect(sseBody).toContain('"toolName":"quiz_generate_mcq"')
    expect(sseBody).toContain('"type":"canvas_op"')
    expect(sseBody).toContain('"type":"done"')
  })

  it('reports the default Douyin in-process plugin as healthy', async () => {
    const reg = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'plugin-health@zhizhi.dev', displayName: 'Health', password: 'password123' }),
    })
    expect(reg.status).toBe(201)
    const token = ((await reg.json()) as { accessToken: string }).accessToken

    const res = await app.request('/api/v1/plugins', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { plugins: SourcePluginHealthReport[] }
    const douyin = body.plugins.find(plugin => plugin.pluginId === DOUYIN_PLUGIN_ID)
    expect(douyin).toMatchObject({ pluginId: 'douyin', mode: 'in_process', ok: true })
  })

  it('ingests a Douyin short link in process, persists StandardMarkdown, and isolates tenants', async () => {
    const awemeId = '7700419372729168881'
    const shortUrl = 'https://v.douyin.com/VerifySlot1/'
    const feedHost = 'api5-normal-c-hl.amemv.com'
    const title = '抖音插槽端到端验证'
    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.href === shortUrl && init?.redirect === 'manual') {
        return new Response(null, {
          status: 302,
          headers: { location: `https://www.douyin.com/video/${awemeId}` },
        })
      }
      if (url.hostname === feedHost && url.pathname === '/aweme/v1/feed/' && url.searchParams.get('aweme_id') === awemeId) {
        return Response.json({
          status_code: 0,
          aweme_list: [{
            aweme_id: awemeId,
            desc: title,
            author: { nickname: '测试博主' },
            video: {
              duration: 30_000,
              play_addr: { url_list: ['https://v1.douyinvod.com/video/test.mp4'] },
            },
          }],
        })
      }
      throw new Error(`Unexpected Douyin request: ${url.href}`)
    })

    const storage = new LocalFsStorageProvider(tempStorageDir)
    const customDeps = createDefaultDependencies(dbHandle, storage, 'test-secret-key-32-bytes-minimum!!', {})
    const plugins = new SourcePluginRegistry()
    plugins.register(createDouyinPlugin({ fetchImpl: mockFetch }))
    const jobs = new DbJobQueue(dbHandle)
    const ingestPipeline = new IngestPipelineService({
      dbHandle,
      storage,
      plugins,
      keyframes: {
        async healthcheck() {
          return { ok: true }
        },
        async extractKeyframes() {
          return []
        },
      },
      defaultSubLoopModelRoute: { provider: 'zhizhi-faux', modelId: 'zhizhi-dev-mock' },
    })
    ingestPipeline.registerJobHandler(jobs)
    const ingestApp = createServerApp({ ...customDeps, plugins, jobs, ingestPipeline })

    const regOwner = await ingestApp.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner-dy@zhizhi.dev', displayName: 'Owner', password: 'password123' }),
    })
    expect(regOwner.status).toBe(201)
    const owner = (await regOwner.json()) as { user: { userId: UserId }; accessToken: string }
    const ownerToken = owner.accessToken

    const regOther = await ingestApp.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'other-dy@zhizhi.dev', displayName: 'Other', password: 'password123' }),
    })
    expect(regOther.status).toBe(201)
    const otherToken = ((await regOther.json()) as { accessToken: string }).accessToken

    const ingestRes = await ingestApp.request('/api/v1/sources/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        sourceType: 'video_note',
        rawText: `3.12 复制打开抖音 ${shortUrl} 看架构设计`,
        disposition: 'wiki_card',
        runNow: true,
      }),
    })
    expect(ingestRes.status).toBe(200)
    const ingestBody = (await ingestRes.json()) as {
      jobId: JobId
      pluginId: PluginId
      job: Omit<JobRecord, 'result'> & { result: IngestPipelineResult }
    }
    expect(ingestBody.pluginId).toBe(DOUYIN_PLUGIN_ID)
    expect(ingestBody.job).toMatchObject({ id: ingestBody.jobId, status: 'succeeded', progress: 100 })
    const { sourceId, wikiCardDraft } = ingestBody.job.result
    expect(wikiCardDraft).toMatchObject({ sourceId, requiresUserSave: true })

    const requestedUrls = mockFetch.mock.calls.map(([input]) => input instanceof Request ? input.url : String(input))
    expect(requestedUrls).toEqual(expect.arrayContaining([shortUrl, expect.stringContaining(feedHost)]))

    // 来源详情从 raw_sources 回读，不依赖采集任务返回的文档。
    const ownerDetail = await ingestApp.request(`/api/v1/sources/${sourceId}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    })
    expect(ownerDetail.status).toBe(200)
    const { source } = (await ownerDetail.json()) as { source: IngestSourceRecord }
    expect(source).toMatchObject({ id: sourceId, disposition: 'wiki_card' })
    const document = StandardMarkdownDocumentSchema.parse({
      frontmatter: source.frontmatterJson,
      bodyMarkdown: source.standardMarkdown,
    })
    expect(document.frontmatter).toMatchObject({ sourceId, userId: owner.user.userId, pluginId: DOUYIN_PLUGIN_ID, title })
    expect(document.bodyMarkdown).toBe(ingestBody.job.result.document.bodyMarkdown)

    const otherDetail = await ingestApp.request(`/api/v1/sources/${sourceId}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    })
    expect(otherDetail.status).toBe(404)

    const otherJob = await ingestApp.request(`/api/v1/jobs/${ingestBody.jobId}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    })
    expect(otherJob.status).toBe(404)

    // 校验 /api/v1/assets 资产直出与多租户隔离（支持 query token 供 <img> 渲染）
    const stored = await storage.put(
      owner.user.userId,
      'frame.jpg',
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      'image/jpeg',
    )
    const ownerAssetRes = await ingestApp.request(
      `/api/v1/assets?key=${encodeURIComponent(stored.assetUrl)}&token=${encodeURIComponent(ownerToken)}`,
    )
    expect(ownerAssetRes.status).toBe(200)
    expect(ownerAssetRes.headers.get('content-type')).toBe('image/jpeg')
    const ownerBytes = new Uint8Array(await ownerAssetRes.arrayBuffer())
    expect(Array.from(ownerBytes)).toEqual([0xff, 0xd8, 0xff, 0xd9])

    // 跨租户读取必须被拦截（403 TENANT_ISOLATION_VIOLATION）
    const otherAssetRes = await ingestApp.request(
      `/api/v1/assets?key=${encodeURIComponent(stored.assetUrl)}&token=${encodeURIComponent(otherToken)}`,
    )
    expect(otherAssetRes.status).toBe(403)
  })
})
