import {
  SourceDispositionSchema,
  SourceTypeSchema,
  StandardMarkdownFrontmatterSchema,
  type SourceDisposition,
  type SourceType,
  type StandardMarkdownFrontmatter,
} from '@zhizhi/contracts'
import { z } from 'zod'

export interface ClientApiConfig {
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
}

export interface AuthSession {
  readonly accessToken: string
  readonly user: {
    readonly userId: string
    readonly role: 'user' | 'admin'
    readonly displayName: string
  }
}

export interface PluginHealthItem {
  readonly pluginId: string
  readonly displayName: string
  readonly mode: 'in_process' | 'mcp'
  readonly supportedTypes: readonly SourceType[]
  readonly needsSubLoop: boolean
  readonly ok: boolean
  readonly detail?: string
}

export interface WikiCardDraftSummary {
  readonly title: string
  readonly bodyMarkdown: string
  readonly sourceId: string
  readonly requiresUserSave: true
}

export interface SourceJobResult {
  readonly sourceId?: string
  readonly disposition?: SourceDisposition
  readonly warnings?: readonly string[]
  readonly wikiCardDraft?: WikiCardDraftSummary
}

export interface ClientJobItem {
  readonly id: string
  readonly jobType: string
  readonly status: string
  readonly progress: number
  readonly payload: Record<string, unknown>
  readonly result: SourceJobResult | null
  readonly errorText: string | null
  readonly attempts: number
}

export interface ClientSourceItem {
  readonly id: string
  readonly userId: string
  readonly pluginId: string
  readonly sourceType: SourceType
  readonly title: string
  readonly disposition: SourceDisposition
  readonly contentHash: string
  readonly frontmatterJson: StandardMarkdownFrontmatter
  readonly standardMarkdown: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface IngestSourceRequest {
  readonly sourceType?: SourceType
  readonly titleHint?: string
  readonly url?: string
  readonly rawText?: string
  readonly disposition?: SourceDisposition
  readonly pluginId?: string
  readonly maxKeyframes?: number
  readonly runNow?: boolean
}

export interface IngestSourceResponse {
  readonly jobId: string
  readonly pluginId: string
  readonly status?: string
  readonly preflight: {
    readonly estimatedChars: number
    readonly requiresSubLoop: boolean
    readonly warningMessage?: string
  }
  readonly job?: ClientJobItem | null
}

const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
})

const AuthSessionSchema = z.object({
  accessToken: z.string().min(1),
  user: z.object({
    userId: z.string().min(1),
    role: z.enum(['user', 'admin']).default('user'),
    displayName: z.string().min(1),
  }),
})

const PluginHealthItemSchema = z.object({
  pluginId: z.string().min(1),
  displayName: z.string().min(1),
  mode: z.enum(['in_process', 'mcp']),
  supportedTypes: z.array(SourceTypeSchema),
  needsSubLoop: z.boolean(),
  ok: z.boolean(),
  detail: z.string().optional(),
})

const WikiCardDraftSchema = z.object({
  title: z.string(),
  bodyMarkdown: z.string(),
  sourceId: z.string(),
  requiresUserSave: z.literal(true),
})

const SourceJobResultSchema = z.object({
  sourceId: z.string().optional(),
  disposition: SourceDispositionSchema.optional(),
  warnings: z.array(z.string()).optional(),
  wikiCardDraft: WikiCardDraftSchema.optional(),
})

const ClientJobItemSchema = z.object({
  id: z.string().min(1),
  jobType: z.string().min(1),
  status: z.string().min(1),
  progress: z.number(),
  payload: z.record(z.string(), z.unknown()),
  result: SourceJobResultSchema.nullable().default(null),
  errorText: z.string().nullable().default(null),
  attempts: z.number(),
})

const ClientSourceItemSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  pluginId: z.string().min(1),
  sourceType: SourceTypeSchema,
  title: z.string(),
  disposition: SourceDispositionSchema,
  contentHash: z.string(),
  frontmatterJson: StandardMarkdownFrontmatterSchema,
  standardMarkdown: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const IngestSourceResponseSchema = z.object({
  jobId: z.string().min(1),
  pluginId: z.string().min(1),
  status: z.string().optional(),
  preflight: z.object({
    estimatedChars: z.number(),
    requiresSubLoop: z.boolean(),
    warningMessage: z.string().optional(),
  }),
  job: ClientJobItemSchema.nullable().optional(),
})

export class ZhizhiApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ZhizhiApiError'
    this.code = code
    this.status = status
  }
}

/**
 * 零 DOM 跨端 API 客户端（Web 与未来 Capacitor / React Native 共用）。
 */
export class ZhizhiApiClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: ClientApiConfig = {}) {
    this.baseUrl = (config.baseUrl ?? '').replace(/\/+$/, '')
    this.fetchImpl = config.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  async register(params: {
    readonly email: string
    readonly displayName: string
    readonly password: string
  }): Promise<AuthSession> {
    const raw = await this.requestJson('/api/v1/auth/register', {
      method: 'POST',
      body: params,
    })
    return parseOrThrow(AuthSessionSchema, raw, 'Invalid register response')
  }

  async login(params: {
    readonly email: string
    readonly password: string
  }): Promise<AuthSession> {
    const raw = await this.requestJson('/api/v1/auth/login', {
      method: 'POST',
      body: params,
    })
    return parseOrThrow(AuthSessionSchema, raw, 'Invalid login response')
  }

  async listPlugins(accessToken: string): Promise<PluginHealthItem[]> {
    const raw = await this.requestJson('/api/v1/plugins', { accessToken })
    const parsed = parseOrThrow(
      z.object({ plugins: z.array(PluginHealthItemSchema) }),
      raw,
      'Invalid plugins response',
    )
    return parsed.plugins.map(item => ({
      pluginId: item.pluginId,
      displayName: item.displayName,
      mode: item.mode,
      supportedTypes: item.supportedTypes,
      needsSubLoop: item.needsSubLoop,
      ok: item.ok,
      ...(item.detail !== undefined ? { detail: item.detail } : {}),
    }))
  }

  async ingestSource(
    accessToken: string,
    payload: IngestSourceRequest,
  ): Promise<IngestSourceResponse> {
    const raw = await this.requestJson('/api/v1/sources/ingest', {
      method: 'POST',
      accessToken,
      body: payload,
    })
    const parsed = parseOrThrow(IngestSourceResponseSchema, raw, 'Invalid ingest response')
    return {
      jobId: parsed.jobId,
      pluginId: parsed.pluginId,
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
      preflight: {
        estimatedChars: parsed.preflight.estimatedChars,
        requiresSubLoop: parsed.preflight.requiresSubLoop,
        ...(parsed.preflight.warningMessage !== undefined
          ? { warningMessage: parsed.preflight.warningMessage }
          : {}),
      },
      ...(parsed.job !== undefined ? { job: parsed.job ? toClientJob(parsed.job) : null } : {}),
    }
  }

  async listJobs(accessToken: string): Promise<ClientJobItem[]> {
    const raw = await this.requestJson('/api/v1/jobs', { accessToken })
    const parsed = parseOrThrow(
      z.object({ jobs: z.array(ClientJobItemSchema) }),
      raw,
      'Invalid jobs response',
    )
    return parsed.jobs.map(toClientJob)
  }

  async getJob(accessToken: string, jobId: string): Promise<ClientJobItem> {
    const raw = await this.requestJson(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { accessToken })
    const parsed = parseOrThrow(
      z.object({ job: ClientJobItemSchema }),
      raw,
      'Invalid job detail response',
    )
    return toClientJob(parsed.job)
  }

  async listSources(accessToken: string): Promise<ClientSourceItem[]> {
    const raw = await this.requestJson('/api/v1/sources', { accessToken })
    const parsed = parseOrThrow(
      z.object({ sources: z.array(ClientSourceItemSchema) }),
      raw,
      'Invalid sources response',
    )
    return parsed.sources
  }

  /**
   * 将 StandardMarkdown 中的 `asset://u/{userId}/assets/...` 转换为受鉴权保护的可渲染 HTTP 地址。
   */
  resolveAssetUrl(accessToken: string, assetUrlOrKey: string): string {
    const trimmed = assetUrlOrKey.trim()
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    const key = trimmed.startsWith('asset://') ? trimmed.slice('asset://'.length) : trimmed
    const params = new URLSearchParams({ key, token: accessToken })
    return `${this.baseUrl}/api/v1/assets?${params.toString()}`
  }

  private async requestJson(
    path: string,
    options: {
      readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
      readonly accessToken?: string
      readonly body?: unknown
    } = {},
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {}
    if (options.accessToken) {
      headers['Authorization'] = `Bearer ${options.accessToken}`
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    })

    const text = await res.text()
    let data: unknown = {}
    if (text.trim().length > 0) {
      try {
        data = JSON.parse(text)
      } catch (_err) {
        throw new ZhizhiApiError('INVALID_JSON', `Unexpected non-JSON response (HTTP ${res.status})`, res.status)
      }
    }

    if (!res.ok) {
      const errParsed = ErrorEnvelopeSchema.safeParse(data)
      if (errParsed.success) {
        throw new ZhizhiApiError(errParsed.data.error.code, errParsed.data.error.message, res.status)
      }
      throw new ZhizhiApiError('HTTP_ERROR', `Request failed with HTTP ${res.status}`, res.status)
    }

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new ZhizhiApiError('SCHEMA_INVALID', 'Expected JSON object response', res.status)
    }
    return data as Record<string, unknown>
  }
}

function toClientJob(raw: z.infer<typeof ClientJobItemSchema>): ClientJobItem {
  const result = raw.result
    ? {
      ...(raw.result.sourceId !== undefined ? { sourceId: raw.result.sourceId } : {}),
      ...(raw.result.disposition !== undefined ? { disposition: raw.result.disposition } : {}),
      ...(raw.result.warnings !== undefined ? { warnings: raw.result.warnings } : {}),
      ...(raw.result.wikiCardDraft !== undefined ? { wikiCardDraft: raw.result.wikiCardDraft } : {}),
    }
    : null
  return {
    id: raw.id,
    jobType: raw.jobType,
    status: raw.status,
    progress: raw.progress,
    payload: raw.payload,
    result,
    errorText: raw.errorText,
    attempts: raw.attempts,
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, fallbackMessage: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new ZhizhiApiError('SCHEMA_INVALID', fallbackMessage, 422)
  }
  return parsed.data
}
