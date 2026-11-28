import { z } from 'zod'
import { mintPluginId, type PluginId } from '@zhizhi/brand'
import type { AsrMediaSource, TranscriptSegment } from '@zhizhi/cap-asr'
import { parseSubtitles } from '@zhizhi/cap-media-frames'
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

export const DOUYIN_PLUGIN_ID: PluginId = mintPluginId('douyin')

export interface DouyinPluginConfig {
  readonly enableMobileFeed?: boolean
  readonly maxGalleryImages?: number
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const DOWNLOAD_HEADERS = { 'User-Agent': MOBILE_UA, Referer: 'https://www.douyin.com/' }
const SHARE_HOSTS = new Set(['douyin.com', 'www.douyin.com', 'm.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com'])
const FEED_ENDPOINTS = ['https://api5-normal-c-hl.amemv.com/aweme/v1/feed/', 'https://aweme.snssdk.com/aweme/v1/feed/']
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_SHORT_LINK_HOPS = 3
const DEFAULT_MAX_GALLERY_IMAGES = 12
const DEFAULT_TIMEOUT_MS = 10_000
const AWEME_ID = /^\d+$/

function parseHttpUrl(value: string, base?: URL): URL | undefined {
  if (!URL.canParse(value, base?.href)) return undefined
  const url = new URL(value, base)
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined
  return url
}

function isShareHost(url: URL): boolean {
  return !url.port && SHARE_HOSTS.has(url.hostname)
}

function getAwemeId(url: URL): string | undefined {
  const pathId = /^\/(?:share\/)?(?:video|note)\/(\d+)\/?$/.exec(url.pathname)?.[1]
  const modalId = /^\/jingxuan\/?$/.test(url.pathname) ? url.searchParams.get('modal_id') : null
  return pathId ?? (modalId && AWEME_ID.test(modalId) ? modalId : undefined)
}

export function extractDouyinUrlFromText(text: string): string | undefined {
  for (const [match] of text.matchAll(/https?:\/\/[^\s<>"'`，。！？、；：《》（）【】「」『』…]+/gi)) {
    const candidate = match.replace(/[,.!?;:)\]}]+$/u, '')
    const url = parseHttpUrl(candidate)
    if (!url || !isShareHost(url)) continue
    if (getAwemeId(url) || (url.hostname === 'v.douyin.com' && /^\/[\w-]+\/?$/.test(url.pathname))) return candidate
  }
  return undefined
}

function findInputUrl(input: RawIngestInput): string | undefined {
  return extractDouyinUrlFromText(`${input.url ?? ''}\n${input.rawText ?? ''}`)
}

export function isDouyinShareInput(input: RawIngestInput): boolean {
  return input.sourceType === 'video_note' && findInputUrl(input) !== undefined
}

/** 只截取标志后的完整 JSON 对象，不把字符串里的花括号计入层级。 */
export function extractJsonObjectAfter(html: string, marker: string): string | undefined {
  if (!marker) return undefined
  const objectStart = /["']?\s*[:=]?\s*\{/y
  let markerIndex = html.indexOf(marker)
  while (markerIndex !== -1) {
    objectStart.lastIndex = markerIndex + marker.length
    if (objectStart.test(html)) break
    markerIndex = html.indexOf(marker, markerIndex + marker.length)
  }
  if (markerIndex === -1) return undefined

  const start = objectStart.lastIndex - 1
  let depth = 1
  let inString = false
  let escaped = false
  for (let i = start + 1; i < html.length; i += 1) {
    const char = html[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return html.slice(start, i + 1)
    }
  }
  return undefined
}

const UrlListSchema = z.object({ url_list: z.array(z.string()).nullish() })
const SubtitleSchema = UrlListSchema.extend({
  url: z.string().nullish(),
  subtitle_url: z.string().nullish(),
  webvtt_url: z.string().nullish(),
})
const VideoSchema = z.object({
  duration: z.number().nullish(),
  play_addr: UrlListSchema.nullish(),
  bit_rate: z.array(z.object({
    bit_rate: z.number().nullish(),
    is_h265: z.number().nullish(),
    play_addr: UrlListSchema.nullish(),
  })).nullish(),
  origin_cover: UrlListSchema.nullish(),
  cover: UrlListSchema.nullish(),
  dynamic_cover: UrlListSchema.nullish(),
  cla_info: z.object({ caption_infos: z.array(SubtitleSchema).nullish() }).nullish(),
  subtitle_infos: z.array(SubtitleSchema).nullish(),
})
const StatisticsSchema = z.object({
  play_count: z.number().nullish(),
  digg_count: z.number().nullish(),
  collect_count: z.number().nullish(),
  comment_count: z.number().nullish(),
  share_count: z.number().nullish(),
})
const AwemeSchema = z.object({
  aweme_id: z.union([z.string().regex(AWEME_ID), z.int().nonnegative()]).optional(),
  desc: z.string().nullish(),
  author: z.object({ nickname: z.string().nullish() }).nullish(),
  statistics: StatisticsSchema.nullish(),
  text_extra: z.array(z.object({ hashtag_name: z.string().nullish() })).nullish(),
  video_tag: z.array(z.object({ tag_name: z.string().nullish() })).nullish(),
  image_post_info: z.object({ images: z.array(UrlListSchema).nullish() }).nullish(),
  images: z.array(UrlListSchema).nullish(),
  video: VideoSchema.nullish(),
  music: z.object({ play_url: UrlListSchema.nullish() }).nullish(),
})
const FeedSchema = z.object({ aweme_list: z.array(z.unknown()) })
const RouterDataSchema = z.object({ loaderData: z.record(z.string(), z.unknown()) })
const LoaderNodeSchema = z.object({ videoInfoRes: z.object({ item_list: z.array(z.unknown()) }) })

type Aweme = z.infer<typeof AwemeSchema>
type Video = z.infer<typeof VideoSchema>

function mediaUrl(value: string | null | undefined): string | undefined {
  return value && parseHttpUrl(value) ? value : undefined
}

function selectVideoUrl(video: Video | null | undefined): string | undefined {
  let best: { url: string; bitrate: number; isH264: boolean } | undefined
  for (const stream of video?.bit_rate ?? []) {
    const url = mediaUrl(stream.play_addr?.url_list?.[0])
    if (!url) continue
    const bitrate = stream.bit_rate ?? 0
    const isH264 = stream.is_h265 === 0
    if (!best || (isH264 && !best.isH264) || (isH264 === best.isH264 && bitrate > best.bitrate)) {
      best = { url, bitrate, isH264 }
    }
  }
  return (best?.url ?? mediaUrl(video?.play_addr?.url_list?.[0]))
    ?.replace(/\/playwm\//g, '/play/')
    .replace(/([?&])ratio=720p(?=&|#|$)/g, '$1ratio=1080p')
}

function collectSubtitleUrls(video: Video | null | undefined): Set<string> {
  const urls = new Set<string>()
  for (const entry of [...(video?.cla_info?.caption_infos ?? []), ...(video?.subtitle_infos ?? [])]) {
    for (const candidate of [entry.url, entry.webvtt_url, entry.subtitle_url, ...(entry.url_list ?? [])]) {
      const url = mediaUrl(candidate)
      if (url) urls.add(url)
    }
  }
  return urls
}

function collectTopics(aweme: Aweme): string[] {
  const tags = [
    ...(aweme.text_extra ?? []).map(extra => extra.hashtag_name),
    ...(aweme.video_tag ?? []).map(tag => tag.tag_name),
  ]
  return [...new Set(tags.map(tag => tag?.trim().replace(/^#+\s*/, '')).filter((tag): tag is string => Boolean(tag)))]
}

function formatRawBody(aweme: Aweme, title: string, author: string, originUrl: string, topics: readonly string[]): string {
  const stats = aweme.statistics
  const counts = [
    ['播放', stats?.play_count],
    ['点赞', stats?.digg_count],
    ['收藏', stats?.collect_count],
    ['评论', stats?.comment_count],
    ['分享', stats?.share_count],
  ].flatMap(([label, count]) => typeof count === 'number' ? [`${label} ${count}`] : [])
  return [
    `# ${title}`,
    '',
    '- 来源平台：抖音',
    `- 作者：${author}`,
    `- 原始链接：${originUrl}`,
    ...(topics.length ? [`- 话题标签：${topics.map(topic => `#${topic}`).join(' ')}`] : []),
    ...(counts.length ? [`- 互动数据：${counts.join(' · ')}`] : []),
    '',
    '## 原始文案',
    '',
    aweme.desc?.trim() || '（无文字文案）',
  ].join('\n')
}

function validPositiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : fallback
}

export class DouyinSourcePlugin implements SourcePlugin {
  readonly pluginId = DOUYIN_PLUGIN_ID
  readonly displayName = '抖音内容采集插件'
  readonly mode = 'in_process' as const
  readonly supportedTypes = ['video_note'] as const
  readonly needsSubLoop = true

  private readonly enableMobileFeed: boolean
  private readonly maxGalleryImages: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(config: DouyinPluginConfig = {}) {
    this.enableMobileFeed = config.enableMobileFeed ?? true
    this.maxGalleryImages = validPositiveInt(config.maxGalleryImages, DEFAULT_MAX_GALLERY_IMAGES)
    this.timeoutMs = validPositiveInt(config.timeoutMs, DEFAULT_TIMEOUT_MS)
    this.fetchImpl = config.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  match(input: RawIngestInput): boolean {
    return isDouyinShareInput(input)
  }

  async healthcheck(): Promise<{ ok: boolean; detail: string }> {
    const tracks = this.enableMobileFeed ? 'mobile-feed + iesdouyin-ssr' : 'iesdouyin-ssr'
    return { ok: true, detail: `In-process Douyin parser ready (${tracks})` }
  }

  async preflight(input: RawIngestInput, _tenant: TenantContext): Promise<PreflightEstimate> {
    if (!this.match(input)) throw new ZhizhiError({ code: 'VALIDATION_FAILED', message: 'No valid Douyin share URL in input' })
    return { estimatedChars: 2400, requiresSubLoop: this.needsSubLoop }
  }

  async extract(input: RawIngestInput, _tenant: TenantContext, runtime?: PluginExtractRuntime): Promise<RawExtractedBundle> {
    const shareUrl = findInputUrl(input)
    if (!shareUrl || input.sourceType !== 'video_note') {
      throw new ZhizhiError({ code: 'VALIDATION_FAILED', message: 'No valid Douyin share URL in input' })
    }
    const signal = runtime?.signal
    signal?.throwIfAborted()
    await runtime?.onProgress?.('fetching_meta', 15, '正在解析抖音作品元数据')
    const awemeId = await this.resolveAwemeId(shareUrl, signal)
    const fromFeed = this.enableMobileFeed ? await this.readMobileFeed(awemeId, signal) : undefined
    const aweme = fromFeed ?? await this.readSharePage(awemeId, signal)

    const images = aweme.image_post_info?.images?.length ? aweme.image_post_info.images : aweme.images ?? []
    const isGallery = images.length > 0
    const author = aweme.author?.nickname?.trim() || '抖音作者'
    const title = (input.titleHint?.trim() || aweme.desc?.trim().split(/[\r\n。！!]/)[0] || `抖音作品 ${awemeId}`).trim().slice(0, 120)
    const originUrl = `https://www.douyin.com/${isGallery ? 'note' : 'video'}/${awemeId}`
    const candidateTopics = collectTopics(aweme)
    const bundle = {
      title,
      originLabel: `${isGallery ? '抖音图文' : '抖音视频'} · ${author}`,
      originUrl,
      anchors: [`aweme_id:${awemeId}`, `author:${author}`],
      rawBody: formatRawBody(aweme, title, author, originUrl, candidateTopics),
      candidateTopics,
    }
    if (isGallery) {
      await runtime?.onProgress?.('downloading_media', 50, '正在下载抖音图文原图')
      const binaryAssets = await this.downloadGallery(images.slice(0, this.maxGalleryImages), signal)
      return { ...bundle, originKind: 'douyin_gallery', binaryAssets, needsAsr: false, needsKeyframes: false }
    }

    const video = aweme.video
    const coverUrl = mediaUrl(video?.origin_cover?.url_list?.[0])
      ?? mediaUrl(video?.cover?.url_list?.[0])
      ?? mediaUrl(video?.dynamic_cover?.url_list?.[0])
    const remoteUrl = selectVideoUrl(video)
    const duration = video?.duration
    const durationSec = duration && duration > 0 ? (duration > 3600 ? Number((duration / 1000).toFixed(2)) : duration) : undefined
    const audioUrl = mediaUrl(aweme.music?.play_url?.url_list?.[0])
    if (audioUrl) bundle.anchors.push(`audio:${audioUrl}`)
    if (durationSec !== undefined) bundle.anchors.push(`duration:${durationSec}s`)

    const mediaRef: AsrMediaSource | undefined = remoteUrl ? {
      kind: 'video', remoteUrl, downloadHeaders: { ...DOWNLOAD_HEADERS },
      ...(durationSec !== undefined ? { durationSec } : {}),
    } : undefined
    const subtitleUrls = collectSubtitleUrls(video)
    if (subtitleUrls.size) await runtime?.onProgress?.('downloading_media', 50, '正在获取抖音原生字幕')
    const transcript = await this.downloadSubtitles(subtitleUrls, signal)

    return {
      ...bundle,
      originKind: 'douyin_video',
      ...(coverUrl ? { fallbackCoverUrl: coverUrl } : {}),
      ...(mediaRef ? { mediaRef } : {}),
      ...(transcript ? { transcript } : {}),
      needsAsr: !transcript,
      needsKeyframes: true,
    }
  }

  private request(url: string, signal?: AbortSignal, redirect: 'manual' | 'error' = 'error'): Promise<Response> {
    signal?.throwIfAborted()
    const timeout = AbortSignal.timeout(this.timeoutMs)
    return this.fetchImpl(url, {
      redirect,
      headers: DOWNLOAD_HEADERS,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  }

  private async resolveAwemeId(shareUrl: string, signal?: AbortSignal): Promise<string> {
    let current = new URL(shareUrl)
    current.protocol = 'https:'
    for (let hop = 0; hop <= MAX_SHORT_LINK_HOPS; hop += 1) {
      signal?.throwIfAborted()
      const awemeId = getAwemeId(current)
      if (awemeId) return awemeId
      if (hop === MAX_SHORT_LINK_HOPS) break

      let response: Response
      try {
        response = await this.request(current.href, signal, 'manual')
      } catch (cause) {
        signal?.throwIfAborted()
        throw new ZhizhiError({ code: 'PLUGIN_UNAVAILABLE', message: 'Failed to expand Douyin share link', retryable: true, cause })
      }
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!REDIRECT_STATUSES.has(response.status) || !location) break
      const target = parseHttpUrl(location, current)
      if (!target || !isShareHost(target)) break
      // 不允许 HTTPS 短链跳转到明文链接；直接提供的 HTTP 分享链接会在请求前升级。
      target.protocol = 'https:'
      current = target
    }
    throw new ZhizhiError({ code: 'VALIDATION_FAILED', message: 'Douyin short link did not resolve to a supported work URL' })
  }

  private async readMobileFeed(awemeId: string, signal?: AbortSignal): Promise<Aweme | undefined> {
    for (const endpoint of FEED_ENDPOINTS) {
      try {
        const response = await this.request(`${endpoint}?aweme_id=${awemeId}&aid=1128`, signal)
        if (!response.ok) {
          await response.body?.cancel()
          continue
        }
        const feed = FeedSchema.safeParse(await response.json())
        if (!feed.success) continue
        for (const item of feed.data.aweme_list) {
          const aweme = AwemeSchema.safeParse(item)
          if (aweme.success && String(aweme.data.aweme_id) === awemeId) return aweme.data
        }
      } catch (_error) {
        signal?.throwIfAborted()
        // 单个 Feed 节点不可用时继续尝试下一节点，再交由分享页降级。
      }
    }
    return undefined
  }

  private async readSharePage(awemeId: string, signal?: AbortSignal): Promise<Aweme> {
    try {
      const response = await this.request(`https://www.iesdouyin.com/share/video/${awemeId}/`, signal)
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`HTTP ${response.status}`)
      }
      const object = extractJsonObjectAfter(await response.text(), '_ROUTER_DATA')
      const router = RouterDataSchema.safeParse(object === undefined ? undefined : JSON.parse(object))
      if (router.success) {
        for (const value of Object.values(router.data.loaderData)) {
          const node = LoaderNodeSchema.safeParse(value)
          if (!node.success) continue
          const aweme = AwemeSchema.safeParse(node.data.videoInfoRes.item_list[0])
          if (aweme.success && (aweme.data.aweme_id === undefined || String(aweme.data.aweme_id) === awemeId)) return aweme.data
        }
      }
    } catch (cause) {
      signal?.throwIfAborted()
      throw new ZhizhiError({ code: 'PLUGIN_UNAVAILABLE', message: 'Failed to fetch Douyin share page metadata', retryable: true, cause })
    }
    throw new ZhizhiError({ code: 'SCHEMA_INVALID', message: 'No matching work found in Douyin share page metadata' })
  }

  private async downloadSubtitles(urls: ReadonlySet<string>, signal?: AbortSignal): Promise<TranscriptSegment[] | undefined> {
    for (const url of urls) {
      try {
        const response = await this.request(url, signal)
        if (!response.ok) {
          await response.body?.cancel()
          continue
        }
        const transcript = parseSubtitles(await response.text())
        if (transcript.length) return transcript
      } catch (_error) {
        signal?.throwIfAborted()
        // 尝试其余字幕链接；全部不可用时由公共 ASR 能力接手。
      }
    }
    return undefined
  }

  private async downloadGallery(images: readonly z.infer<typeof UrlListSchema>[], signal?: AbortSignal): Promise<RawBinaryAsset[]> {
    const assets: RawBinaryAsset[] = []
    for (const [index, image] of images.entries()) {
      const url = mediaUrl(image.url_list?.at(-1))
      if (!url) continue
      try {
        const response = await this.request(url, signal)
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || 'image/jpeg'
        const ext = /^image\/(jpeg|png|webp|gif|avif)$/.exec(contentType)?.[1]
        if (!response.ok || !ext) {
          await response.body?.cancel()
          continue
        }
        const data = new Uint8Array(await response.arrayBuffer())
        if (data.length) {
          assets.push({
            name: `douyin-gallery-${index + 1}.${ext === 'jpeg' ? 'jpg' : ext}`,
            contentType,
            data,
            caption: `抖音图文第 ${index + 1} 张`,
          })
        }
      } catch (_error) {
        signal?.throwIfAborted()
        // 跳过单张损坏或不可用的图片，保留原始文案及其他图片。
      }
    }
    return assets
  }
}

export function createDouyinPlugin(config?: DouyinPluginConfig): DouyinSourcePlugin {
  return new DouyinSourcePlugin(config)
}

export function createDouyinPluginFromEnv(env: NodeJS.ProcessEnv = process.env): DouyinSourcePlugin {
  return createDouyinPlugin({
    enableMobileFeed: !/^(?:false|0|off)$/i.test(env['ZHIZHI_DOUYIN_ENABLE_MOBILE_FEED']?.trim() ?? ''),
    maxGalleryImages: Number(env['ZHIZHI_DOUYIN_MAX_GALLERY_IMAGES']),
    timeoutMs: Number(env['ZHIZHI_DOUYIN_TIMEOUT_MS']),
  })
}
