import { z } from 'zod'
import { mintPluginId } from '@zhizhi/brand'
import {
  StreamableHttpMcpClient,
  type McpClientHandle,
} from '@zhizhi/cap-mcp-client'
import type { TenantContext } from '@zhizhi/contracts'
import { ZhizhiError } from '@zhizhi/errors'
import type {
  PluginExtractRuntime,
  PreflightEstimate,
  RawBinaryAsset,
  RawExtractedBundle,
  RawIngestInput,
  SourcePlugin,
} from '@zhizhi/plugin-sdk'

export const DOUYIN_DTK_PLUGIN_ID = mintPluginId('douyin-dtk')

const DOUYIN_URL_PATTERN =
  /https?:\/\/(?:v\.douyin\.com\/[^\s]+|(?:www\.|m\.)?(?:douyin|iesdouyin)\.com\/(?:video|note|jingxuan|share\/video|share\/note)[^\s]*)/i

const DtkPendingEnvelopeSchema = z.object({
  status: z.string(),
  task_id: z.string().nullable().optional(),
  download_id: z.string().nullable().optional(),
  transcription_id: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
  platform: z.string().nullable().optional(),
  content_id: z.string().nullable().optional(),
  data: z.unknown().optional(),
})

const DtkPoolStatusSchema = z.object({
  summary: z.string().optional(),
  usable_identities: z.record(z.string(), z.number()).optional(),
})

const DtkAuthorSchema = z.object({
  nickname: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  uid: z.string().nullable().optional(),
})

const DtkImageSchema = z.object({
  url: z.string().optional(),
  urls: z.array(z.string()).optional(),
  url_list: z.array(z.string()).optional(),
})

const DtkMediaItemSchema = z.union([z.string(), DtkImageSchema])

const DtkVideoStreamSchema = z.object({
  url: z.string().optional(),
  urls: z.array(z.string()).optional(),
})

const DtkMediaBlockSchema = z.object({
  covers: z.array(DtkImageSchema).optional(),
  video: DtkVideoStreamSchema.nullable().optional(),
  streams: z.array(DtkVideoStreamSchema).optional(),
  images: z.array(DtkMediaItemSchema).optional(),
  access: z
    .object({
      referer: z.string().nullable().optional(),
      session_bound: z.boolean().optional(),
    })
    .optional(),
})

const DtkStatsSchema = z.object({
  play_count: z.number().nullable().optional(),
  digg_count: z.number().nullable().optional(),
  comment_count: z.number().nullable().optional(),
  collect_count: z.number().nullable().optional(),
  share_count: z.number().nullable().optional(),
})

const DtkContentDataSchema = z.object({
  content_id: z.string().optional(),
  aweme_id: z.string().optional(),
  kind: z.string().optional(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  desc: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  web_url: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  canonical_url: z.string().nullable().optional(),
  media_type: z.string().nullable().optional(),
  author: DtkAuthorSchema.nullable().optional(),
  author_name: z.string().nullable().optional(),
  cover_url: z.string().nullable().optional(),
  video_url: z.string().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  duration: z.number().nullable().optional(),
  duration_sec: z.number().nullable().optional(),
  media: DtkMediaBlockSchema.nullable().optional(),
  images: z.array(DtkMediaItemSchema).optional(),
  image_urls: z.array(z.string()).optional(),
  hashtags: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  stats: DtkStatsSchema.nullable().optional(),
  statistics: DtkStatsSchema.nullable().optional(),
})

const DtkDownloadDataSchema = z.object({
  download_id: z.string().nullable().optional(),
  id: z.string().nullable().optional(),
  file_path: z.string().nullable().optional(),
  local_path: z.string().nullable().optional(),
  video_url: z.string().nullable().optional(),
  media_url: z.string().nullable().optional(),
})

const DtkTranscriptionDataSchema = z.object({
  text: z.string().nullable().optional(),
  transcript: z.string().nullable().optional(),
  full_text: z.string().nullable().optional(),
})

export interface DouyinDtkPluginConfig {
  readonly endpointUrl?: string
  readonly apiKey?: string
  readonly mcpClient?: McpClientHandle
  readonly preferDtkTranscription?: boolean
  readonly requireTimestampedAsr?: boolean
  readonly maxGalleryImages?: number
  readonly pollIntervalMs?: number
  readonly maxPollAttempts?: number
  readonly fetchImpl?: typeof fetch
}

/**
 * 从抖音分享口令或纯 URL 文本中提取规范链接（自动剔除末尾中文标点）。
 */
export function extractDouyinUrlFromText(text: string): string | undefined {
  const match = DOUYIN_URL_PATTERN.exec(text)
  if (!match?.[0]) return undefined
  return match[0].replace(/[，。！？、》）】」"'`]+$/u, '')
}

export function isDouyinShareInput(input: RawIngestInput): boolean {
  const combined = [input.url, input.rawText].filter((v): v is string => Boolean(v)).join('\n')
  return extractDouyinUrlFromText(combined) !== undefined
}

function normalizeDurationSec(
  durationMs: number | null | undefined,
  rawDuration: number | null | undefined,
  rawDurationSec: number | null | undefined,
): number | undefined {
  if (typeof durationMs === 'number' && durationMs > 0) return Number((durationMs / 1000).toFixed(2))
  if (typeof rawDurationSec === 'number' && rawDurationSec > 0) return rawDurationSec
  if (typeof rawDuration !== 'number' || rawDuration <= 0) return undefined
  return rawDuration > 3600 ? Number((rawDuration / 1000).toFixed(2)) : rawDuration
}

function collectGalleryUrls(data: z.infer<typeof DtkContentDataSchema>): string[] {
  const urls: string[] = []
  const items = [...(data.media?.images ?? []), ...(data.images ?? [])]
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.trim() && !urls.includes(item.trim())) urls.push(item.trim())
    } else if (item.url && !urls.includes(item.url)) {
      urls.push(item.url)
    } else if (item.urls && item.urls.length > 0 && item.urls[0] && !urls.includes(item.urls[0])) {
      urls.push(item.urls[0])
    } else if (item.url_list && item.url_list.length > 0) {
      const best = item.url_list[item.url_list.length - 1]
      if (best && !urls.includes(best)) urls.push(best)
    }
  }
  for (const u of data.image_urls ?? []) {
    if (u.trim() && !urls.includes(u.trim())) {
      urls.push(u.trim())
    }
  }
  return urls
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ZhizhiError({ code: 'JOB_FAILED', message: 'Douyin DTK task aborted' }))
      return
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ZhizhiError({ code: 'JOB_FAILED', message: 'Douyin DTK task aborted' }))
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * 路线 A 抖音来源插槽插件：通过受控 Streamable HTTP MCP 客户端接入 DTK v5（`/mcp/`）。
 * 未配置或 DTK 离线时仅在 healthcheck 上报降级，绝不阻断知枝主服务启动。
 */
export class DouyinDtkSourcePlugin implements SourcePlugin {
  readonly pluginId = DOUYIN_DTK_PLUGIN_ID
  readonly displayName = '抖音内容采集插件（DTK v5 MCP）'
  readonly mode = 'mcp' as const
  readonly supportedTypes = ['video_note'] as const
  readonly urlPatterns = [DOUYIN_URL_PATTERN] as const
  readonly needsSubLoop = true

  private readonly mcpClient: McpClientHandle | undefined
  private readonly preferDtkTranscription: boolean
  private readonly requireTimestampedAsr: boolean
  private readonly maxGalleryImages: number
  private readonly pollIntervalMs: number
  private readonly maxPollAttempts: number
  private readonly fetchImpl: typeof fetch

  constructor(config: DouyinDtkPluginConfig = {}) {
    if (config.mcpClient) {
      this.mcpClient = config.mcpClient
    } else if (config.endpointUrl && config.endpointUrl.trim().length > 0) {
      this.mcpClient = new StreamableHttpMcpClient({
        endpointUrl: config.endpointUrl.trim(),
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
        ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
      })
    } else {
      this.mcpClient = undefined
    }

    this.preferDtkTranscription = config.preferDtkTranscription ?? true
    this.requireTimestampedAsr = config.requireTimestampedAsr ?? false
    this.maxGalleryImages = config.maxGalleryImages ?? 12
    this.pollIntervalMs = config.pollIntervalMs ?? 1_500
    this.maxPollAttempts = config.maxPollAttempts ?? 15
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
  }

  match(input: RawIngestInput): boolean {
    return isDouyinShareInput(input)
  }

  async healthcheck(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.mcpClient) {
      return { ok: false, detail: 'DTK_MCP_URL is not configured (plugin in standby mode)' }
    }

    try {
      const res = await this.mcpClient.callTool('pool_status', {})
      if (res.isError) {
        return { ok: false, detail: res.text || 'DTK pool_status reported error' }
      }
      const parsed = DtkPoolStatusSchema.safeParse(res.json)
      if (!parsed.success) {
        return { ok: true, detail: res.text || 'DTK MCP reachable' }
      }
      const douyinActive = parsed.data.usable_identities?.['douyin']
      const summary = parsed.data.summary ?? 'DTK MCP reachable'
      if (douyinActive !== undefined && douyinActive <= 0) {
        return { ok: false, detail: `No active Douyin identities in pool (${summary})` }
      }
      return { ok: true, detail: summary }
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async preflight(input: RawIngestInput, _tenant: TenantContext): Promise<PreflightEstimate> {
    const combined = [input.url, input.rawText].filter((v): v is string => Boolean(v)).join('\n')
    const url = extractDouyinUrlFromText(combined)
    if (!url) {
      throw new ZhizhiError({
        code: 'VALIDATION_FAILED',
        message: 'Input does not contain a recognized Douyin share URL',
      })
    }
    return {
      estimatedChars: 2400,
      requiresSubLoop: true,
      ...(!this.mcpClient ? { warningMessage: 'DTK_MCP_URL is not configured yet' } : {}),
    }
  }

  async extract(
    input: RawIngestInput,
    _tenant: TenantContext,
    runtime?: PluginExtractRuntime,
  ): Promise<RawExtractedBundle> {
    const client = this.mcpClient
    if (!client) {
      throw new ZhizhiError({
        code: 'PLUGIN_UNAVAILABLE',
        message: 'Douyin DTK plugin is not configured: set DTK_MCP_URL and DTK_API_KEY',
      })
    }

    const combined = [input.url, input.rawText].filter((v): v is string => Boolean(v)).join('\n')
    const shareUrl = extractDouyinUrlFromText(combined)
    if (!shareUrl) {
      throw new ZhizhiError({
        code: 'VALIDATION_FAILED',
        message: 'No valid Douyin URL found in input',
      })
    }

    await runtime?.onProgress?.('fetching_meta', 15, '正在通过 DTK v5 解析抖音作品元数据')
    const parsePayload = await this.callWithPendingPolling(
      client,
      'parse_url',
      { url: shareUrl },
      runtime?.signal,
    )

    const contentParsed = DtkContentDataSchema.safeParse(parsePayload.data ?? parsePayload)
    if (!contentParsed.success) {
      throw new ZhizhiError({
        code: 'SCHEMA_INVALID',
        message: 'DTK parse_url returned invalid Douyin content schema',
        details: { issues: contentParsed.error.issues },
      })
    }
    const content = contentParsed.data
    const contentId = parsePayload.content_id ?? content.content_id ?? content.aweme_id ?? ''
    const author = content.author?.nickname ?? content.author?.name ?? content.author_name ?? '抖音作者'
    const desc = (content.description ?? content.desc ?? content.caption ?? '').trim()
    const title = (input.titleHint ?? content.title ?? desc.split(/[\n。！!]/)[0] ?? `抖音作品 ${contentId || '未知'}`)
      .trim()
      .slice(0, 120)
    const canonicalUrl =
      content.web_url
      ?? content.canonical_url
      ?? content.url
      ?? (contentId ? `https://www.douyin.com/video/${contentId}` : shareUrl)
    const hashtags = [...(content.hashtags ?? []), ...(content.tags ?? [])]
      .map(t => t.replace(/^#/, '').trim())
      .filter(Boolean)
    const stats = content.stats ?? content.statistics ?? undefined
    const mediaReferer = content.media?.access?.referer ?? undefined
    const coverUrl = content.media?.covers?.[0]?.url ?? content.cover_url ?? undefined
    const initialVideoUrl = content.media?.video?.url ?? content.media?.streams?.[0]?.url ?? content.video_url ?? undefined

    const galleryUrls = collectGalleryUrls(content)
    const kindLower = (content.kind ?? content.media_type ?? '').toLowerCase()
    const isGallery =
      kindLower === 'image_album'
      || kindLower === 'gallery'
      || kindLower === 'image'
      || galleryUrls.length > 0

    if (isGallery && galleryUrls.length > 0) {
      await runtime?.onProgress?.('downloading_media', 50, `正在获取抖音图文原图（共 ${Math.min(galleryUrls.length, this.maxGalleryImages)} 张）`)
      const binaryAssets = await this.downloadGalleryAssets(
        galleryUrls.slice(0, this.maxGalleryImages),
        mediaReferer,
        runtime?.signal,
      )
      return {
        title,
        originKind: 'douyin_gallery',
        originLabel: `抖音图文 · ${author}`,
        originUrl: canonicalUrl,
        anchors: [
          ...(contentId ? [`aweme_id:${contentId}`] : []),
          `author:${author}`,
        ],
        rawBody: this.formatRawBody({
          title,
          author,
          canonicalUrl,
          desc,
          hashtags,
          statistics: stats,
        }),
        candidateTopics: hashtags.slice(0, 6),
        binaryAssets,
        needsAsr: false,
        needsKeyframes: false,
      }
    }

    // 视频分支：优先走 DTK download_media + transcribe_video，失败或需要时间戳时交回公共 ASR
    await runtime?.onProgress?.('downloading_media', 40, '正在通过 DTK v5 下载无水印视频')
    let downloadId: string | undefined
    let localMediaPath: string | undefined
    let remoteVideoUrl: string | undefined = initialVideoUrl

    if (contentId) {
      try {
        const dlPayload = await this.callWithPendingPolling(
          client,
          'download_media',
          { platform: 'douyin', content_id: contentId },
          runtime?.signal,
        )
        const dlParsed = DtkDownloadDataSchema.safeParse(dlPayload.data ?? dlPayload)
        downloadId = dlPayload.download_id ?? undefined
        if (dlParsed.success) {
          downloadId = downloadId ?? dlParsed.data.download_id ?? dlParsed.data.id ?? undefined
          localMediaPath = dlParsed.data.local_path ?? dlParsed.data.file_path ?? undefined
          remoteVideoUrl = dlParsed.data.video_url ?? dlParsed.data.media_url ?? remoteVideoUrl
        }
      } catch (_err) {
        // Fallback: keep metadata + remoteVideoUrl / cover so pipeline can still degrade cleanly.
      }
    }

    let dtkTranscriptText = ''
    let needsFallbackAsr = true
    const hasTimestampAsr = runtime?.capabilities?.asr?.supportsTimestamps === true
    const shouldUseDtkAsr =
      this.preferDtkTranscription
      && !this.requireTimestampedAsr
      && Boolean(downloadId)
      && !hasTimestampAsr

    if (shouldUseDtkAsr && downloadId) {
      await runtime?.onProgress?.('transcribing', 65, '正在调用 DTK 离线 FunASR 转写语音')
      try {
        const txPayload = await this.callWithPendingPolling(
          client,
          'transcribe_video',
          { download_id: downloadId, normalize: true },
          runtime?.signal,
        )
        const txParsed = DtkTranscriptionDataSchema.safeParse(txPayload.data ?? txPayload)
        if (txParsed.success) {
          dtkTranscriptText = (txParsed.data.text ?? txParsed.data.transcript ?? txParsed.data.full_text ?? '').trim()
          if (dtkTranscriptText.length > 0) {
            needsFallbackAsr = false
          }
        }
      } catch (_err) {
        // DTK transcriber profile may be disabled; hand off to shared AsrProvider.
        needsFallbackAsr = true
      }
    }

    const durationSec = normalizeDurationSec(content.duration_ms, content.duration, content.duration_sec)
    const downloadHeaders = mediaReferer ? { Referer: mediaReferer } : undefined
    const mediaRef =
      localMediaPath || remoteVideoUrl
        ? {
          kind: 'video' as const,
          ...(localMediaPath ? { localPath: localMediaPath } : {}),
          ...(remoteVideoUrl ? { remoteUrl: remoteVideoUrl } : {}),
          ...(downloadHeaders ? { downloadHeaders } : {}),
          ...(durationSec !== undefined ? { durationSec } : {}),
        }
        : undefined

    return {
      title,
      originKind: 'douyin_video',
      originLabel: `抖音视频 · ${author}`,
      originUrl: canonicalUrl,
      anchors: [
        ...(contentId ? [`aweme_id:${contentId}`] : []),
        `author:${author}`,
        ...(durationSec !== undefined ? [`duration:${Math.round(durationSec)}s`] : []),
      ],
      rawBody: this.formatRawBody({
        title,
        author,
        canonicalUrl,
        desc,
        hashtags,
        statistics: stats,
        transcriptText: dtkTranscriptText,
      }),
      candidateTopics: hashtags.slice(0, 6),
      ...(mediaRef ? { mediaRef } : {}),
      ...(coverUrl ? { fallbackCoverUrl: coverUrl } : {}),
      needsAsr: needsFallbackAsr,
      needsKeyframes: true,
    }
  }

  private async callWithPendingPolling(
    client: McpClientHandle,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof DtkPendingEnvelopeSchema>> {
    const first = await client.callTool(toolName, args, signal)
    if (first.isError) {
      throw new ZhizhiError({
        code: 'PLUGIN_UNAVAILABLE',
        message: `DTK MCP tool "${toolName}" failed: ${first.text || 'unknown error'}`,
        retryable: true,
      })
    }

    const initialParsed = DtkPendingEnvelopeSchema.safeParse(first.json)
    if (!initialParsed.success) {
      return { status: 'ok', data: first.json ?? { text: first.text } }
    }

    let current = initialParsed.data
    let attempts = 0
    while (current.status === 'pending') {
      if (!current.task_id) {
        throw new ZhizhiError({
          code: 'SCHEMA_INVALID',
          message: `DTK MCP tool "${toolName}" returned pending without task_id`,
        })
      }
      attempts += 1
      if (attempts > this.maxPollAttempts) {
        throw new ZhizhiError({
          code: 'JOB_FAILED',
          message: `DTK MCP task "${current.task_id}" timed out while polling`,
          retryable: true,
        })
      }

      await sleepWithAbort(this.pollIntervalMs, signal)
      const pollRes = await client.callTool('get_task_result', { task_id: current.task_id }, signal)
      if (pollRes.isError) {
        throw new ZhizhiError({
          code: 'PLUGIN_UNAVAILABLE',
          message: `DTK get_task_result failed: ${pollRes.text || 'unknown error'}`,
          retryable: true,
        })
      }
      const nextParsed = DtkPendingEnvelopeSchema.safeParse(pollRes.json)
      if (!nextParsed.success) {
        return { status: 'ok', data: pollRes.json ?? { text: pollRes.text } }
      }
      current = nextParsed.data
    }

    return current
  }

  private async downloadGalleryAssets(
    urls: readonly string[],
    referer?: string,
    signal?: AbortSignal,
  ): Promise<RawBinaryAsset[]> {
    const assets: RawBinaryAsset[] = []
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i]
      if (!url) continue
      try {
        const res = await this.fetchImpl(url, {
          ...(referer ? { headers: { Referer: referer } } : {}),
          ...(signal ? { signal } : {}),
        })
        if (!res.ok) continue
        const ab = await res.arrayBuffer()
        if (ab.byteLength === 0) continue
        const contentType = res.headers.get('content-type') ?? 'image/jpeg'
        const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
        assets.push({
          name: `douyin-gallery-${i + 1}.${ext}`,
          contentType,
          data: new Uint8Array(ab),
          caption: `抖音图文第 ${i + 1} 张`,
        })
      } catch (_err) {
        // Skip single failed gallery image so remaining images are preserved.
      }
    }
    return assets
  }

  private formatRawBody(params: {
    readonly title: string
    readonly author: string
    readonly canonicalUrl: string
    readonly desc: string
    readonly hashtags: readonly string[]
    readonly statistics?: {
      readonly digg_count?: number | null | undefined
      readonly comment_count?: number | null | undefined
      readonly collect_count?: number | null | undefined
      readonly share_count?: number | null | undefined
    } | undefined
    readonly transcriptText?: string
  }): string {
    const lines: string[] = [
      `# ${params.title}`,
      '',
      '- 来源平台：抖音',
      `- 作者：${params.author}`,
      `- 原始链接：${params.canonicalUrl}`,
    ]
    if (params.hashtags.length > 0) {
      lines.push(`- 话题标签：${params.hashtags.map(t => `#${t}`).join(' ')}`)
    }
    if (params.statistics) {
      const parts: string[] = []
      if (typeof params.statistics.digg_count === 'number') parts.push(`点赞 ${params.statistics.digg_count}`)
      if (typeof params.statistics.collect_count === 'number') parts.push(`收藏 ${params.statistics.collect_count}`)
      if (typeof params.statistics.comment_count === 'number') parts.push(`评论 ${params.statistics.comment_count}`)
      if (parts.length > 0) {
        lines.push(`- 互动数据：${parts.join(' · ')}`)
      }
    }
    lines.push('', '## 原始文案', '', params.desc || '（无文字文案）')
    if (params.transcriptText && params.transcriptText.trim().length > 0) {
      lines.push('', '## 语音转写全文（DTK 离线 FunASR）', '', params.transcriptText.trim())
    }
    return lines.join('\n')
  }
}

export function createDouyinDtkPlugin(config: DouyinDtkPluginConfig = {}): DouyinDtkSourcePlugin {
  return new DouyinDtkSourcePlugin(config)
}

export function createDouyinDtkPluginFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DouyinDtkSourcePlugin {
  const endpointUrl = env['DTK_MCP_URL']?.trim()
  const apiKey = env['DTK_API_KEY']?.trim()
  const preferDtk = env['DTK_PREFER_TRANSCRIPTION'] !== 'false'
  return new DouyinDtkSourcePlugin({
    ...(endpointUrl ? { endpointUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    preferDtkTranscription: preferDtk,
  })
}
