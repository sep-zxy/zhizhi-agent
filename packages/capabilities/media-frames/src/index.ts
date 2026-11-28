import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AsrMediaSource, TranscriptSegment } from '@zhizhi/cap-asr'
import { ZhizhiError } from '@zhizhi/errors'

const execFileAsync = promisify(execFile)

export interface KeyframeTarget {
  readonly timestampSec: number
  readonly caption: string
}

export interface ExtractedKeyframeAsset {
  readonly name: string
  readonly contentType: string
  readonly data: Uint8Array
  readonly caption: string
  readonly timestampSec?: number
  readonly strategy: 'L1_timestamp' | 'L2_uniform' | 'L3_cover_fallback'
}

export interface KeyframeExtractionRequest {
  readonly media?: AsrMediaSource
  readonly transcript?: readonly TranscriptSegment[]
  readonly targets?: readonly KeyframeTarget[]
  readonly fallbackCoverUrl?: string
  readonly maxFrames?: number
  readonly signal?: AbortSignal
}

/**
 * 公共基础能力缝隙：字幕解析 + 三级兜底重点截图（L1 时间戳定位 → L2 等分兜底 → L3 封面兜底）。
 */
export interface KeyframeExtractor {
  healthcheck(): Promise<{ ok: boolean; detail?: string }>
  extractKeyframes(request: KeyframeExtractionRequest): Promise<ExtractedKeyframeAsset[]>
}

/**
 * 解析 WebVTT 或 SRT 字幕为统一的 TranscriptSegment[]，并自动合并连续重复行。
 */
export function parseSubtitles(raw: string): TranscriptSegment[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/^﻿/, '').trim()
  if (!normalized) return []

  const blocks = normalized.split(/\n{2,}/)
  const segments: TranscriptSegment[] = []

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    if (lines.length === 0) continue

    const timeLineIndex = lines.findIndex(line => line.includes('-->'))
    if (timeLineIndex === -1) continue

    const timeLine = lines[timeLineIndex] ?? ''
    const parts = timeLine.split('-->')
    const startSec = parseSubtitleTimestamp(parts[0] ?? '')
    const endSec = parseSubtitleTimestamp((parts[1] ?? '').trim().split(/\s+/)[0] ?? '')
    if (startSec === null || endSec === null) continue

    const text = lines
      .slice(timeLineIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue

    const prev = segments[segments.length - 1]
    if (prev && prev.text === text) {
      segments[segments.length - 1] = {
        startSec: prev.startSec,
        endSec: Math.max(prev.endSec, endSec),
        text: prev.text,
      }
      continue
    }

    segments.push({ startSec, endSec, text })
  }

  return segments
}

export function formatTimestampLabel(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = safe % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`
}

/**
 * 在没有 LLM 指定时间点时，基于字幕时间轴均匀选取重点锚点，用于 L1 精准抽帧。
 */
export function selectKeyframeTargetsFromTranscript(
  segments: readonly TranscriptSegment[],
  maxFrames = 4,
): KeyframeTarget[] {
  if (segments.length === 0 || maxFrames <= 0) return []
  const count = Math.min(maxFrames, segments.length)
  if (count === 1) {
    const seg = segments[0]
    if (!seg) return []
    return [{ timestampSec: seg.startSec, caption: seg.text.slice(0, 60) }]
  }

  const targets: KeyframeTarget[] = []
  for (let i = 0; i < count; i += 1) {
    const idx = Math.round((i * (segments.length - 1)) / (count - 1))
    const seg = segments[idx]
    if (!seg) continue
    const midSec = Number(((seg.startSec + seg.endSec) / 2).toFixed(2))
    targets.push({
      timestampSec: midSec,
      caption: `[${formatTimestampLabel(midSec)}] ${seg.text.slice(0, 60)}`,
    })
  }
  return targets
}

/**
 * 计算 L2 均匀抽帧兜底时间点（跳过片头片尾，默认取 15% / 50% / 85%）。
 */
export function computeUniformFallbackTimestamps(
  durationSec: number,
  maxFrames = 3,
): KeyframeTarget[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || maxFrames <= 0) return []
  const count = Math.max(1, Math.min(maxFrames, 6))
  const ratios = count === 1
    ? [0.5]
    : Array.from({ length: count }, (_, idx) => 0.15 + (0.7 * idx) / (count - 1))

  return ratios.map((ratio, idx) => {
    const sec = Number((durationSec * ratio).toFixed(2))
    return {
      timestampSec: sec,
      caption: `关键画面 #${idx + 1} (${formatTimestampLabel(sec)})`,
    }
  })
}

export interface FfmpegKeyframeExtractorConfig {
  readonly ffmpegPath?: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

/**
 * 基于系统 FFmpeg 的三级兜底重点帧截图实现：
 * - L1：有字幕时间戳或显式 targets 时定向 `-ss` 抽帧
 * - L2：无时间戳但有视频时长时按 15% / 50% / 85% 等分抽帧
 * - L3：无视频流或 FFmpeg 不可用时，回退拉取封面图 `fallbackCoverUrl`（永不拖垮主采集任务）
 */
export class FfmpegKeyframeExtractor implements KeyframeExtractor {
  private readonly ffmpegPath: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(config: FfmpegKeyframeExtractorConfig = {}) {
    this.ffmpegPath = config.ffmpegPath ?? 'ffmpeg'
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
    this.timeoutMs = config.timeoutMs ?? 20_000
  }

  async healthcheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const { stdout } = await execFileAsync(this.ffmpegPath, ['-version'], { timeout: 5_000 })
      const firstLine = stdout.split(/\r?\n/)[0]?.trim() ?? 'ffmpeg available'
      return { ok: true, detail: firstLine }
    } catch (err) {
      return {
        ok: false,
        detail: `ffmpeg unavailable (${err instanceof Error ? err.message : String(err)}); will fall back to L3 cover image`,
      }
    }
  }

  async extractKeyframes(request: KeyframeExtractionRequest): Promise<ExtractedKeyframeAsset[]> {
    const maxFrames = request.maxFrames ?? 4
    const media = request.media

    if (media && media.kind === 'video' && (media.localPath || media.remoteUrl)) {
      const l1Targets =
        request.targets && request.targets.length > 0
          ? request.targets.slice(0, maxFrames)
          : request.transcript && request.transcript.length > 0
            ? selectKeyframeTargetsFromTranscript(request.transcript, maxFrames)
            : []

      const l2Targets =
        l1Targets.length === 0 && media.durationSec && media.durationSec > 0
          ? computeUniformFallbackTimestamps(media.durationSec, Math.min(maxFrames, 3))
          : []

      const targets = l1Targets.length > 0 ? l1Targets : l2Targets
      const strategy: 'L1_timestamp' | 'L2_uniform' =
        l1Targets.length > 0 ? 'L1_timestamp' : 'L2_uniform'

      if (targets.length > 0) {
        const frames = await this.captureTargetsWithFfmpeg(media, targets, strategy, request.signal)
        if (frames.length > 0) {
          return frames
        }
      }
    }

    // L3 封面兜底
    if (request.fallbackCoverUrl) {
      const cover = await this.fetchCoverAsset(request.fallbackCoverUrl, request.signal)
      if (cover) {
        return [cover]
      }
    }

    return []
  }

  private async captureTargetsWithFfmpeg(
    media: AsrMediaSource,
    targets: readonly KeyframeTarget[],
    strategy: 'L1_timestamp' | 'L2_uniform',
    signal?: AbortSignal,
  ): Promise<ExtractedKeyframeAsset[]> {
    const inputSource = media.localPath ?? media.remoteUrl
    if (!inputSource) return []

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhizhi-frames-'))
    const results: ExtractedKeyframeAsset[] = []

    try {
      for (let i = 0; i < targets.length; i += 1) {
        if (signal?.aborted) {
          throw new ZhizhiError({ code: 'JOB_FAILED', message: 'Keyframe extraction aborted' })
        }
        const target = targets[i]
        if (!target) continue

        const outFile = path.join(tmpDir, `frame_${i + 1}.jpg`)
        const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y']

        if (!media.localPath && media.downloadHeaders && Object.keys(media.downloadHeaders).length > 0) {
          const headerLines = Object.entries(media.downloadHeaders)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n')
          args.push('-headers', `${headerLines}\r\n`)
        }

        args.push(
          '-ss',
          String(Math.max(0, target.timestampSec)),
          '-i',
          inputSource,
          '-frames:v',
          '1',
          '-q:v',
          '4',
          outFile,
        )

        try {
          await execFileAsync(this.ffmpegPath, args, {
            timeout: this.timeoutMs,
            ...(signal ? { signal } : {}),
          })
          const buf = await fs.readFile(outFile)
          if (buf.byteLength > 0) {
            results.push({
              name: `keyframe-${i + 1}-${Math.round(target.timestampSec)}s.jpg`,
              contentType: 'image/jpeg',
              data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
              caption: target.caption,
              timestampSec: target.timestampSec,
              strategy,
            })
          }
        } catch (_err) {
          // Single-frame FFmpeg error falls through so remaining frames or L3 cover fallback can succeed.
        }
      }
      return results
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }

  private async fetchCoverAsset(
    coverUrl: string,
    signal?: AbortSignal,
  ): Promise<ExtractedKeyframeAsset | null> {
    try {
      const res = await this.fetchImpl(coverUrl, signal ? { signal } : undefined)
      if (!res.ok) return null
      const ab = await res.arrayBuffer()
      if (ab.byteLength === 0) return null
      const contentType = res.headers.get('content-type') ?? 'image/jpeg'
      const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
      return {
        name: `cover.${ext}`,
        contentType,
        data: new Uint8Array(ab),
        caption: '视频封面参考图（L3 兜底）',
        strategy: 'L3_cover_fallback',
      }
    } catch (_err) {
      // Cover download failure is non-fatal for text-only ingest degradation.
      return null
    }
  }
}

function parseSubtitleTimestamp(token: string): number | null {
  const cleaned = token.trim().replace(',', '.')
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(cleaned)
  if (!match) return null
  const hours = match[1] ? Number(match[1]) : 0
  const minutes = Number(match[2] ?? '0')
  const seconds = Number(match[3] ?? '0')
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null
  }
  return Number((hours * 3600 + minutes * 60 + seconds).toFixed(3))
}
