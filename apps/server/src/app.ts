import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  createDefaultToolRegistry,
  inspectPiAgentRuntime,
  runPiAgentTurn,
  type ModelRouteSpec,
  type ZhizhiToolRegistry,
} from '@zhizhi/agent-runtime'
import {
  asBrand,
  mintMessageId,
  mintPluginId,
  mintSessionId,
  mintSlotId,
  type JobId,
  type SourceId,
} from '@zhizhi/brand'
import {
  DisabledAsrProvider,
  OpenAiCompatibleAsrProvider,
  type AsrProvider,
} from '@zhizhi/cap-asr'
import { FfmpegKeyframeExtractor } from '@zhizhi/cap-media-frames'
import {
  CanvasSlotStateSchema,
  ChatTurnRequestSchema,
  PageSceneSchema,
  SourceDispositionSchema,
  SourceTypeSchema,
  type TenantContext,
} from '@zhizhi/contracts'
import {
  chatMessages,
  chatSessions,
  pageCanvasStates,
  userApiKeys,
  withTenant,
  type DatabaseHandle,
} from '@zhizhi/db'
import { isZhizhiError, ZhizhiError } from '@zhizhi/errors'
import { IngestPipelineService } from '@zhizhi/ingest-pipeline'
import { DbJobQueue } from '@zhizhi/jobs'
import { createDouyinDtkPluginFromEnv } from '@zhizhi/plugin-douyin-dtk'
import { SourcePluginRegistry } from '@zhizhi/plugin-sdk'
import type { StorageProvider } from '@zhizhi/storage'
import { authenticateUser, registerUser, signAccessToken, verifyAccessToken } from './auth.ts'

export interface ServerDependencies {
  readonly dbHandle: DatabaseHandle
  readonly storage: StorageProvider
  readonly jobs: DbJobQueue
  readonly plugins: SourcePluginRegistry
  readonly ingestPipeline: IngestPipelineService
  readonly tools: ZhizhiToolRegistry
  readonly jwtSecret: string
}

type AppVariables = {
  tenant: TenantContext
}

const RegisterBodySchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(60),
  password: z.string().min(8).max(128),
})

const LoginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const SaveCanvasStateBodySchema = z.object({
  pageScene: PageSceneSchema,
  sessionId: z.string().min(1).default('default'),
  slots: z.array(CanvasSlotStateSchema),
})

const IngestSourceBodySchema = z.object({
  sourceType: SourceTypeSchema.default('video_note'),
  titleHint: z.string().min(1).max(200).optional(),
  url: z.string().url().optional(),
  rawText: z.string().min(1).optional(),
  mimeType: z.string().optional(),
  disposition: SourceDispositionSchema.default('archive_only'),
  pluginId: z.string().min(1).optional(),
  maxKeyframes: z.number().int().min(1).max(8).optional(),
  runNow: z.boolean().default(false),
})

export function createServerApp(deps: ServerDependencies): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>()

  app.use('*', cors())

  app.onError((err, c) => {
    if (isZhizhiError(err)) {
      return c.json({ error: err.toJSON() }, err.httpStatus as 400)
    }
    const fallback = new ZhizhiError({
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : 'Unexpected server error',
    })
    return c.json({ error: fallback.toJSON() }, 500)
  })

  // 健康检查：暴露驱动形态、Pi Agent 运行时状态与已装载插槽插件
  app.get('/api/v1/health', (c) => {
    return c.json({
      status: 'ok',
      dbDriver: deps.dbHandle.driver,
      storageDriver: deps.storage.driver,
      agentRuntime: inspectPiAgentRuntime(),
      plugins: deps.plugins.list(),
    })
  })

  // V1 原生多人账号注册与登录
  app.post('/api/v1/auth/register', async (c) => {
    const raw: unknown = await c.req.json()
    const parsed = RegisterBodySchema.safeParse(raw)
    if (!parsed.success) {
      throw new ZhizhiError({
        code: 'VALIDATION_FAILED',
        message: 'Invalid registration payload',
        details: { issues: parsed.error.issues },
      })
    }
    const created = await registerUser(deps.dbHandle, parsed.data)
    const token = await signAccessToken({ userId: created.userId, role: 'user' }, deps.jwtSecret)
    return c.json({ user: created, accessToken: token }, 201)
  })

  app.post('/api/v1/auth/login', async (c) => {
    const raw: unknown = await c.req.json()
    const parsed = LoginBodySchema.safeParse(raw)
    if (!parsed.success) {
      throw new ZhizhiError({
        code: 'VALIDATION_FAILED',
        message: 'Invalid login payload',
        details: { issues: parsed.error.issues },
      })
    }
    const { tenant, displayName } = await authenticateUser(
      deps.dbHandle,
      parsed.data.email,
      parsed.data.password,
    )
    const token = await signAccessToken(tenant, deps.jwtSecret)
    return c.json({
      user: { userId: tenant.userId, role: tenant.role, displayName },
      accessToken: token,
    })
  })

  // 以下路由全部受严格多租户鉴权中间件保护（严禁信任前端传入 userId）
  const protectedApi = new Hono<{ Variables: AppVariables }>()

  protectedApi.use('*', async (c, next) => {
    const authHeader = c.req.header('authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new ZhizhiError({ code: 'UNAUTHORIZED', message: 'Missing Bearer access token' })
    }
    const token = authHeader.slice(7).trim()
    const tenant = await verifyAccessToken(token, deps.jwtSecret)
    c.set('tenant', tenant)
    await next()
  })

  protectedApi.get('/me', (c) => {
    const tenant = c.get('tenant')
    return c.json({ userId: tenant.userId, role: tenant.role })
  })

  // 按情境页保存 / 恢复页内卡片槽与 Pin 状态记忆（ADR-06）
  protectedApi.get('/canvas-state', async (c) => {
    const tenant = c.get('tenant')
    const sceneResult = PageSceneSchema.safeParse(c.req.query('pageScene') ?? 'chat_qa')
    if (!sceneResult.success) {
      throw new ZhizhiError({ code: 'VALIDATION_FAILED', message: 'Invalid pageScene query' })
    }
    const sessionId = c.req.query('sessionId') ?? 'default'

    const slots = await withTenant(deps.dbHandle, tenant, async (db) => {
      const rows = await db
        .select()
        .from(pageCanvasStates)
        .where(
          and(
            eq(pageCanvasStates.userId, tenant.userId),
            eq(pageCanvasStates.pageScene, sceneResult.data),
            eq(pageCanvasStates.sessionId, sessionId),
          ),
        )
        .limit(1)
      return rows[0]?.slotsJson ?? []
    })

    return c.json({ pageScene: sceneResult.data, sessionId, slots })
  })

  protectedApi.put('/canvas-state', async (c) => {
    const tenant = c.get('tenant')
    const raw: unknown = await c.req.json()
    const parsed = SaveCanvasStateBodySchema.safeParse(raw)
    if (!parsed.success) {
      throw new ZhizhiError({
        code: 'VALIDATION_FAILED',
        message: 'Invalid canvas state payload',
        details: { issues: parsed.error.issues },
      })
    }

    await withTenant(deps.dbHandle, tenant, async (db) => {
      await db
        .insert(pageCanvasStates)
        .values({
          id: mintSlotId(),
          userId: tenant.userId,
          pageScene: parsed.data.pageScene,
          sessionId: parsed.data.sessionId,
          slotsJson: parsed.data.slots,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [pageCanvasStates.userId, pageCanvasStates.pageScene, pageCanvasStates.sessionId],
          set: { slotsJson: parsed.data.slots, updatedAt: new Date() },
        })
    })

    return c.json({ ok: true })
  })

  // 统一 AI 对话双通道 SSE 接口（真实 Pi Agent Core 主循环 + 文本流 + canvas_op 受控画布指令）
  protectedApi.post('/chat/turn', async (c) => {
    const tenant = c.get('tenant')
    const raw: unknown = await c.req.json()
    const parsed = ChatTurnRequestSchema.safeParse(raw)
    if (!parsed.success) {
      throw new ZhizhiError({
        code: 'VALIDATION_FAILED',
        message: 'Invalid chat turn payload',
        details: { issues: parsed.error.issues },
      })
    }
    const sessionId = parsed.data.sessionId ?? mintSessionId()

    // 确保会话归属当前租户并读取用户的 main_loop 模型配置（若已配置）
    const route = await withTenant(deps.dbHandle, tenant, async (db): Promise<ModelRouteSpec | undefined> => {
      await db
        .insert(chatSessions)
        .values({ id: sessionId, userId: tenant.userId, title: parsed.data.message.slice(0, 30) })
        .onConflictDoNothing()

      await db.insert(chatMessages).values({
        id: mintMessageId(),
        userId: tenant.userId,
        sessionId,
        role: 'user',
        content: parsed.data.message,
      })

      const rows = await db
        .select()
        .from(userApiKeys)
        .where(and(eq(userApiKeys.userId, tenant.userId), eq(userApiKeys.scene, 'main_loop')))
        .limit(1)
      const cfg = rows[0]
      if (!cfg) return undefined
      return {
        provider: cfg.provider,
        modelId: cfg.modelId,
        apiKey: cfg.encryptedSecret,
        ...(cfg.baseUrl !== null ? { baseUrl: cfg.baseUrl } : {}),
      }
    })

    return streamSSE(c, async (stream) => {
      const result = await runPiAgentTurn({
        tenant,
        request: parsed.data,
        sessionId,
        registry: deps.tools,
        ...(route !== undefined ? { modelRoute: route } : {}),
        emit(event) {
          void stream.writeSSE({ data: JSON.stringify(event) })
        },
      })

      await withTenant(deps.dbHandle, tenant, async (db) => {
        await db.insert(chatMessages).values({
          id: mintMessageId(),
          userId: tenant.userId,
          sessionId,
          role: 'assistant',
          content: result.finalText,
        })
      })
    })
  })

  // 查询已注册来源插槽及实时健康状态（验证 ADR-02 可拆卸与离线降级）
  protectedApi.get('/plugins', async (c) => {
    const plugins = await deps.plugins.inspectHealth()
    return c.json({ plugins })
  })

  // 投递来源采集任务至持久化异步队列（ADR-02 + ADR-03，严禁阻塞写库）
  protectedApi.post('/sources/ingest', async (c) => {
    const tenant = c.get('tenant')
    const raw: unknown = await c.req.json()
    const parsed = IngestSourceBodySchema.safeParse(raw)
    if (!parsed.success) {
      throw new ZhizhiError({
        code: 'VALIDATION_FAILED',
        message: 'Invalid source ingest payload',
        details: { issues: parsed.error.issues },
      })
    }

    const input = {
      sourceType: parsed.data.sourceType,
      ...(parsed.data.titleHint !== undefined ? { titleHint: parsed.data.titleHint } : {}),
      ...(parsed.data.url !== undefined ? { url: parsed.data.url } : {}),
      ...(parsed.data.rawText !== undefined ? { rawText: parsed.data.rawText } : {}),
      ...(parsed.data.mimeType !== undefined ? { mimeType: parsed.data.mimeType } : {}),
    }
    const targetPlugin =
      parsed.data.pluginId !== undefined
        ? deps.plugins.get(mintPluginId(parsed.data.pluginId))
        : deps.plugins.resolveForInput(input)
    const preflight = await targetPlugin.preflight(input, tenant)

    const jobId = await deps.jobs.enqueue(tenant, {
      jobType: 'ingest_sub_loop',
      payload: {
        input,
        disposition: parsed.data.disposition,
        pluginId: targetPlugin.pluginId,
        ...(parsed.data.maxKeyframes !== undefined ? { maxKeyframes: parsed.data.maxKeyframes } : {}),
      },
    })

    if (parsed.data.runNow) {
      const completed = await deps.jobs.runNextForTenant(tenant)
      return c.json({ jobId, pluginId: targetPlugin.pluginId, preflight, job: completed }, 200)
    }

    return c.json({ jobId, pluginId: targetPlugin.pluginId, preflight, status: 'queued' }, 202)
  })

  // 查询当前租户沉淀的 StandardMarkdown 来源列表与详情
  protectedApi.get('/sources', async (c) => {
    const tenant = c.get('tenant')
    const sources = await deps.ingestPipeline.listSourcesByTenant(tenant)
    return c.json({ sources })
  })

  protectedApi.get('/sources/:id', async (c) => {
    const tenant = c.get('tenant')
    const sourceId = asBrand<SourceId>(c.req.param('id'))
    const source = await deps.ingestPipeline.getSourceByTenant(tenant, sourceId)
    if (!source) {
      throw new ZhizhiError({ code: 'NOT_FOUND', message: `Source "${sourceId}" not found` })
    }
    return c.json({ source })
  })

  // 查询当前账号异步任务队列（解析子循环 + 入库默认 2 题任务）
  protectedApi.get('/jobs', async (c) => {
    const tenant = c.get('tenant')
    const jobs = await deps.jobs.listByTenant(tenant)
    return c.json({ jobs })
  })

  protectedApi.get('/jobs/:id', async (c) => {
    const tenant = c.get('tenant')
    const jobId = asBrand<JobId>(c.req.param('id'))
    const job = await deps.jobs.getByIdForTenant(tenant, jobId)
    if (!job) {
      throw new ZhizhiError({ code: 'NOT_FOUND', message: `Job "${jobId}" not found` })
    }
    return c.json({ job })
  })

  app.route('/api/v1', protectedApi)
  return app
}

function createAsrProviderFromEnv(env: NodeJS.ProcessEnv): AsrProvider {
  const baseUrl = env['ZHIZHI_ASR_BASE_URL']?.trim()
  const apiKey = env['ZHIZHI_ASR_API_KEY']?.trim()
  const model = env['ZHIZHI_ASR_MODEL']?.trim() || 'FunAudioLLM/SenseVoiceSmall'
  if (baseUrl && apiKey) {
    return new OpenAiCompatibleAsrProvider({ baseUrl, apiKey, model })
  }
  return new DisabledAsrProvider()
}

export function createDefaultDependencies(
  dbHandle: DatabaseHandle,
  storage: StorageProvider,
  jwtSecret: string,
  env: NodeJS.ProcessEnv = process.env,
): ServerDependencies {
  const jobs = new DbJobQueue(dbHandle)
  const plugins = new SourcePluginRegistry()
  plugins.register(createDouyinDtkPluginFromEnv(env))

  const ingestPipeline = new IngestPipelineService({
    dbHandle,
    storage,
    plugins,
    asr: createAsrProviderFromEnv(env),
    keyframes: new FfmpegKeyframeExtractor(),
  })
  ingestPipeline.registerJobHandler(jobs)

  return {
    dbHandle,
    storage,
    jobs,
    plugins,
    ingestPipeline,
    tools: createDefaultToolRegistry(),
    jwtSecret,
  }
}
