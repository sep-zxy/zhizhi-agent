import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import type { McpClientHandle } from '@zhizhi/cap-mcp-client'
import { createDatabase, type DatabaseHandle } from '@zhizhi/db'
import { createDouyinDtkPlugin, DOUYIN_DTK_PLUGIN_ID } from '@zhizhi/plugin-douyin-dtk'
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
    const deps = createDefaultDependencies(dbHandle, storage, 'test-secret-key-32-bytes-minimum!!')
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

  it('reports standby douyin plugin health without blocking server startup', async () => {
    const reg = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'plugin-health@zhizhi.dev', displayName: 'Health', password: 'password123' }),
    })
    const token = ((await reg.json()) as { accessToken: string }).accessToken

    const res = await app.request('/api/v1/plugins', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { plugins: Array<{ pluginId: string; ok: boolean; detail?: string }> }
    const douyin = body.plugins.find(p => p.pluginId === DOUYIN_DTK_PLUGIN_ID)
    expect(douyin).toBeDefined()
    expect(douyin?.ok).toBe(false)
    expect(douyin?.detail).toContain('DTK_MCP_URL')
  })

  it('ingests a Douyin share text through MCP slot, persists StandardMarkdown, and isolates tenants', async () => {
    const mockMcp: McpClientHandle = {
      async listTools() {
        return ['pool_status', 'parse_url', 'download_media', 'transcribe_video']
      },
      async ping() {
        return { ok: true, latencyMs: 1 }
      },
      async callTool(name) {
        if (name === 'pool_status') {
          return { isError: false, text: '', json: { usable_identities: { douyin: 2 }, summary: 'douyin: 2 active' } }
        }
        if (name === 'parse_url') {
          return {
            isError: false,
            text: '',
            json: {
              status: 'ok',
              content_id: '79990001',
              data: {
                title: '抖音插槽端到端验证',
                desc: '验证四域拆分后的抖音采集闭环 #知枝',
                author: { nickname: '测试博主' },
                duration_sec: 30,
                hashtags: ['知枝'],
              },
            },
          }
        }
        if (name === 'download_media') {
          return { isError: false, text: '', json: { status: 'ok', data: { download_id: 'dl_e2e_1' } } }
        }
        if (name === 'transcribe_video') {
          return {
            isError: false,
            text: '',
            json: { status: 'ok', data: { text: '这是来自 DTK 离线 FunASR 的转写文本。' } },
          }
        }
        return { isError: true, text: `unknown tool ${name}`, json: undefined }
      },
    }

    const storage = new LocalFsStorageProvider(tempStorageDir)
    const customDeps = createDefaultDependencies(dbHandle, storage, 'test-secret-key-32-bytes-minimum!!', {})
    // Swap standby plugin for mocked healthy DTK plugin via disposer-compatible fresh registry
    const isolatedDeps = {
      ...customDeps,
    }
    const freshPlugin = createDouyinDtkPlugin({ mcpClient: mockMcp })
    // Re-register with a fresh registry wired into a fresh pipeline for this isolated test app
    const { SourcePluginRegistry } = await import('@zhizhi/plugin-sdk')
    const { IngestPipelineService } = await import('@zhizhi/ingest-pipeline')
    const { DbJobQueue } = await import('@zhizhi/jobs')
    const plugins = new SourcePluginRegistry()
    plugins.register(freshPlugin)
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
    const ingestApp = createServerApp({
      ...isolatedDeps,
      plugins,
      jobs,
      ingestPipeline,
    })

    const regOwner = await ingestApp.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner-dy@zhizhi.dev', displayName: 'Owner', password: 'password123' }),
    })
    const ownerToken = ((await regOwner.json()) as { accessToken: string }).accessToken

    const regOther = await ingestApp.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'other-dy@zhizhi.dev', displayName: 'Other', password: 'password123' }),
    })
    const otherToken = ((await regOther.json()) as { accessToken: string }).accessToken

    const ingestRes = await ingestApp.request('/api/v1/sources/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        sourceType: 'video_note',
        rawText: '3.12 复制打开抖音 https://v.douyin.com/VerifySlot1/ 看架构设计',
        disposition: 'wiki_card',
        runNow: true,
      }),
    })
    expect(ingestRes.status).toBe(200)
    const ingestBody = (await ingestRes.json()) as {
      jobId: string
      pluginId: string
      job: { status: string; progress: number; result: { sourceId: string; wikiCardDraft: { requiresUserSave: boolean } } }
    }
    expect(ingestBody.pluginId).toBe(DOUYIN_DTK_PLUGIN_ID)
    expect(ingestBody.job.status).toBe('succeeded')
    expect(ingestBody.job.progress).toBe(100)
    expect(ingestBody.job.result.wikiCardDraft.requiresUserSave).toBe(true)

    const sourceId = ingestBody.job.result.sourceId
    const ownerDetail = await ingestApp.request(`/api/v1/sources/${sourceId}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    })
    expect(ownerDetail.status).toBe(200)

    const otherDetail = await ingestApp.request(`/api/v1/sources/${sourceId}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    })
    expect(otherDetail.status).toBe(404)

    const otherJob = await ingestApp.request(`/api/v1/jobs/${ingestBody.jobId}`, {
      headers: { authorization: `Bearer ${otherToken}` },
    })
    expect(otherJob.status).toBe(404)
  })
})
