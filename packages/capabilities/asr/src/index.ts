import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { ZhizhiError } from '@zhizhi/errors'

const execFileAsync = promisify(execFile)

export interface TranscriptSegment {
  readonly startSec: number
  readonly endSec: number
  readonly text: string
  readonly speaker?: string
}

export interface AsrMediaSource {
  readonly kind: 'video' | 'audio'
  readonly localPath?: string
  readonly remoteUrl?: string
  readonly downloadHeaders?: Record<string, string>
  readonly durationSec?: number
}

export interface AsrTranscribeRequest {
  readonly media: AsrMediaSource
  readonly languageHint?: string
  readonly signal?: AbortSignal
}

export interface AsrTranscribeResult {
  readonly providerId: string
  readonly fullText: string
  readonly segments: TranscriptSegment[]
}

/**
 * 公共基础能力缝隙：语音转写（ASR）。
 * 抖音、B 站、YouTube、播客与本地视频来源共享此接口，严禁在单平台插件内重复实现 ASR 逻辑。
 */
export interface AsrProvider {
  readonly providerId: string
  readonly supportsTimestamps: boolean
  healthcheck(): Promise<{ ok: boolean; detail?: string }>
  transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult>
}

export interface OpenAiCompatibleAsrConfig {
  readonly providerId?: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly ffmpegPath?: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

const WhisperVerboseResponseSchema = z.object({
  text: z.string().default(''),
  segments: z
    .array(
      z.object({
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
        text: z.string(),
      }),
    )
    .optional(),
})

/**
 * OpenAI 兼容语音转写适配器（支持硅基流动 SenseVoice / Groq Whisper / 兼容网关 / 本地 Whisper Server）。
 */
export class OpenAiCompatibleAsrProvider implements AsrProvider {
  readonly providerId: string
  readonly supportsTimestamps = true
  private readonly endpointUrl: string
  private readonly apiKey: string
  private readonly model: string
  private readonly ffmpegPath: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(config: OpenAiCompatibleAsrConfig) {
    this.providerId = config.providerId ?? 'openai-compatible-asr'
    const normalizedBase = config.baseUrl.replace(/\/+$/, '')
    this.endpointUrl = normalizedBase.endsWith('/audio/transcriptions')
      ? normalizedBase
      : `${normalizedBase}/audio/transcriptions`
    this.apiKey = config.apiKey
    this.model = config.model
    this.ffmpegPath = config.ffmpegPath ?? 'ffmpeg'
    this.fetchImpl = config.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.timeoutMs = config.timeoutMs ?? 120_000
  }

  async healthcheck(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.apiKey.trim()) {
      return { ok: false, detail: 'ASR API key is not configured' }
    }
    return { ok: true, detail: `Configured (${this.model})` }
  }

  async transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    if (!this.apiKey.trim()) {
      throw new ZhizhiError({
        code: 'PLUGIN_UNAVAILABLE',
        message: `ASR provider "${this.providerId}" is missing API key`,
      })
    }

    const loaded = await loadMediaBytes(
      request.media,
      this.fetchImpl,
      request.signal,
    )
    const { bytes, filename, contentType } =
      request.media.kind === 'video' || loaded.contentType.startsWith('video/') || loaded.filename.endsWith('.mp4')
        ? await extractAudioTrackIfPossible(loaded, this.ffmpegPath, request.signal)
        : loaded

    const form = new FormData()
    const blob = new Blob([Uint8Array.from(bytes)], { type: contentType })
    form.append('file', blob, filename)
    form.append('model', this.model)
    form.append('response_format', 'verbose_json')
    if (request.languageHint) {
      form.append('language', request.languageHint)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('ASR request timed out')), this.timeoutMs)
    const onAbort = (): void => controller.abort(request.signal?.reason)
    if (request.signal) {
      if (request.signal.aborted) {
        onAbort()
      } else {
        request.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    let response: Response
    try {
      response = await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: form,
        signal: controller.signal,
      })
    } catch (err) {
      throw new ZhizhiError({
        code: 'PLUGIN_UNAVAILABLE',
        message: `ASR request failed: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        cause: err,
      })
    } finally {
      clearTimeout(timer)
      if (request.signal) {
        request.signal.removeEventListener('abort', onAbort)
      }
    }

    if (!response.ok) {
      const errPreview = (await response.text()).slice(0, 300)
      throw new ZhizhiError({
        code: 'PLUGIN_UNAVAILABLE',
        message: `ASR provider returned HTTP ${response.status}`,
        retryable: response.status >= 500 || response.status === 429,
        details: { status: response.status, preview: errPreview },
      })
    }

    const raw: unknown = await response.json()
    const parsed = WhisperVerboseResponseSchema.safeParse(raw)
    if (!parsed.success) {
      throw new ZhizhiError({
        code: 'SCHEMA_INVALID',
        message: 'ASR response failed schema validation',
        details: { issues: parsed.error.issues },
      })
    }

    const segments: TranscriptSegment[] = (parsed.data.segments ?? [])
      .map(seg => ({
        startSec: seg.start,
        endSec: seg.end,
        text: seg.text.trim(),
      }))
      .filter(seg => seg.text.length > 0)

    const fullText = parsed.data.text.trim() || segments.map(s => s.text).join(' ')
    return {
      providerId: this.providerId,
      fullText,
      segments,
    }
  }
}

/**
 * 显式无 ASR 配置占位实现：用于本地零 Key 场景下的明确降级提示。
 */
export class DisabledAsrProvider implements AsrProvider {
  readonly providerId = 'asr-disabled'
  readonly supportsTimestamps = false

  async healthcheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: false, detail: 'No external timestamped ASR provider configured' }
  }

  async transcribe(): Promise<AsrTranscribeResult> {
    throw new ZhizhiError({
      code: 'PLUGIN_UNAVAILABLE',
      message: 'No ASR provider is configured for fallback transcription',
    })
  }
}

async function loadMediaBytes(
  media: AsrMediaSource,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly filename: string; readonly contentType: string }> {
  if (media.localPath) {
    const buf = await fs.readFile(media.localPath)
    const filename = path.basename(media.localPath) || 'audio.mp3'
    return {
      bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      filename,
      contentType: inferAudioContentType(filename),
    }
  }

  if (media.remoteUrl) {
    const res = await fetchImpl(media.remoteUrl, {
      ...(media.downloadHeaders ? { headers: media.downloadHeaders } : {}),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) {
      throw new ZhizhiError({
        code: 'PLUGIN_UNAVAILABLE',
        message: `Failed to download media for ASR (HTTP ${res.status})`,
        retryable: res.status >= 500,
      })
    }
    const ab = await res.arrayBuffer()
    const contentType = res.headers.get('content-type') ?? (media.kind === 'audio' ? 'audio/mpeg' : 'video/mp4')
    const ext = contentType.includes('audio') ? '.mp3' : '.mp4'
    return {
      bytes: new Uint8Array(ab),
      filename: `source${ext}`,
      contentType,
    }
  }

  throw new ZhizhiError({
    code: 'VALIDATION_FAILED',
    message: 'AsrMediaSource must provide either localPath or remoteUrl',
  })
}

function inferAudioContentType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.m4a')) return 'audio/mp4'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.mp4')) return 'video/mp4'
  return 'application/octet-stream'
}

/**
 * 公共音频预处理：多数云端 ASR（如 Groq Whisper 25MB 限制、硅基流动 SenseVoice 仅支持纯音频）
 * 不接收原始 MP4 视频。遇到视频输入时自动通过本机 FFmpeg 抽出 16kHz 单声道 64kbps MP3，
 * FFmpeg 不可用时优雅保留原字节不阻断单测与兜底路径。
 */
async function extractAudioTrackIfPossible(
  loaded: { readonly bytes: Uint8Array; readonly filename: string; readonly contentType: string },
  ffmpegPath: string,
  signal?: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly filename: string; readonly contentType: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhizhi-asr-'))
  const inPath = path.join(tmpDir, loaded.filename || 'input.mp4')
  const outPath = path.join(tmpDir, 'audio.mp3')
  try {
    await fs.writeFile(inPath, loaded.bytes)
    await execFileAsync(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '64k',
        outPath,
      ],
      { timeout: 60_000, ...(signal ? { signal } : {}) },
    )
    const audioBuf = await fs.readFile(outPath)
    if (audioBuf.byteLength > 0) {
      return {
        bytes: new Uint8Array(audioBuf.buffer, audioBuf.byteOffset, audioBuf.byteLength),
        filename: 'audio.mp3',
        contentType: 'audio/mpeg',
      }
    }
    return loaded
  } catch (_err) {
    // FFmpeg missing or transcode error falls back to uploading the original payload.
    return loaded
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}
