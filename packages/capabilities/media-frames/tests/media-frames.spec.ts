import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeUniformFallbackTimestamps,
  FfmpegKeyframeExtractor,
  parseSubtitles,
  selectKeyframeTargetsFromTranscript,
  type KeyframeExtractionRequest,
} from '@zhizhi/cap-media-frames'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((
    _file: string,
    _args: string[],
    _options: object,
    callback: (error: Error) => void,
  ) => {
    callback(Object.assign(new Error('ffmpeg executable not found'), { code: 'ENOENT' }))
  }),
}))

vi.mock('node:fs/promises', () => ({
  default: {
    mkdtemp: vi.fn().mockResolvedValue('/virtual/zhizhi-frames-test'),
    readFile: vi.fn().mockRejectedValue(new Error('No frame file was created')),
    rm: vi.fn().mockResolvedValue(undefined),
  },
}))

describe('parseSubtitles', () => {
  it('strips WebVTT tags, joins wrapped text and merges adjacent duplicate cues only', () => {
    const raw = [
      '﻿WEBVTT',
      '',
      '00:00.250 -->00:01.250 align:start',
      '<b>第一段</b>',
      '换行',
      '',
      '00:01.250 -->00:02.500',
      '<i>第一段</i>   换行',
      '',
      '00:02.500 -->00:03.000',
      '第二段',
      '',
      '00:03.000 -->00:04.000',
      '第一段 换行',
    ].join('\r\n')

    expect(parseSubtitles(raw)).toEqual([
      { startSec: 0.25, endSec: 2.5, text: '第一段 换行' },
      { startSec: 2.5, endSec: 3, text: '第二段' },
      { startSec: 3, endSec: 4, text: '第一段 换行' },
    ])
  })

  it('handles numbered SRT cues with comma milliseconds and skips malformed cues', () => {
    const raw = [
      '1',
      '00:01:02,345 -->00:01:04,678',
      '<i>SRT 台词</i>',
      '',
      '2',
      'invalid -->00:01:08,000',
      '无效时间',
    ].join('\n')

    expect(parseSubtitles(raw)).toEqual([{ startSec: 62.345, endSec: 64.678, text: 'SRT 台词' }])
  })

  it.each([
    ['WebVTT', 'WEBVTT\n\n00:00.250 --> 00:01.500 align:start\n字幕'],
    ['SRT', '1\n00:00:00,250 --> 00:00:01,500\n字幕'],
  ])('accepts standard %s whitespace around the cue arrow', (_format, raw) => {
    expect(parseSubtitles(raw)).toEqual([{ startSec: 0.25, endSec: 1.5, text: '字幕' }])
  })
})

describe('selectKeyframeTargetsFromTranscript', () => {
  const segments = [
    { startSec: 0.125, endSec: 1.125, text: '开头' },
    { startSec: 4, endSec: 6, text: '中间' },
    { startSec: 62, endSec: 63, text: '结尾' },
  ]

  it('returns no targets for empty subtitles or a nonpositive frame limit', () => {
    expect(selectKeyframeTargetsFromTranscript([])).toEqual([])
    expect(selectKeyframeTargetsFromTranscript(segments, 0)).toEqual([])
    expect(selectKeyframeTargetsFromTranscript(segments, -1)).toEqual([])
  })

  it('uses the first segment start time and truncates its caption for a single target', () => {
    const text = '长'.repeat(61)
    const segment = { startSec: 1.25, endSec: 3, text }
    const expected = [{ timestampSec: 1.25, caption: text.slice(0, 60) }]

    expect(selectKeyframeTargetsFromTranscript([segment])).toEqual(expected)
    expect(selectKeyframeTargetsFromTranscript([segment, ...segments], 1)).toEqual(expected)
  })

  it('samples across the transcript and caps the target count to the segment count', () => {
    const first = { timestampSec: 0.63, caption: '[00:00] 开头' }
    const last = { timestampSec: 62.5, caption: '[01:02] 结尾' }

    expect(selectKeyframeTargetsFromTranscript(segments, 2)).toEqual([first, last])
    expect(selectKeyframeTargetsFromTranscript(segments, 10)).toEqual([
      first,
      { timestampSec: 5, caption: '[00:05] 中间' },
      last,
    ])
  })
})

describe('computeUniformFallbackTimestamps', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('returns no targets for invalid duration %s', (duration) => {
    expect(computeUniformFallbackTimestamps(duration)).toEqual([])
  })

  it('returns no targets for a nonpositive frame limit', () => {
    expect(computeUniformFallbackTimestamps(100, 0)).toEqual([])
    expect(computeUniformFallbackTimestamps(100, -1)).toEqual([])
  })

  it('uses a midpoint for one frame and skips both ends by default', () => {
    expect(computeUniformFallbackTimestamps(10.5, 1)).toEqual([
      { timestampSec: 5.25, caption: '关键画面 #1 (00:05)' },
    ])
    expect(computeUniformFallbackTimestamps(100).map(target => target.timestampSec)).toEqual([15, 50, 85])
  })

  it('caps the number of frames at six while keeping them evenly spaced', () => {
    expect(computeUniformFallbackTimestamps(100, 20).map(target => target.timestampSec))
      .toEqual([15, 29, 43, 57, 71, 85])
  })
})

describe('FfmpegKeyframeExtractor', () => {
  const ffmpegPath = '/virtual/nonexistent-ffmpeg'
  const fallbackCoverUrl = 'https://media.example.test/cover.png'
  const request: KeyframeExtractionRequest = {
    media: { kind: 'video', localPath: '/virtual/lesson.mp4', durationSec: 10 },
    fallbackCoverUrl,
    maxFrames: 1,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns an L3 cover asset after FFmpeg is unavailable', async () => {
    const coverBytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47)
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(coverBytes, {
      headers: { 'content-type': 'image/png' },
    }))
    const extractor = new FfmpegKeyframeExtractor({ ffmpegPath, fetchImpl })

    const assets = await extractor.extractKeyframes({
      ...request,
      targets: [{ timestampSec: 2, caption: '指定画面' }],
    })

    expect(assets).toEqual([{
      name: 'cover.png',
      contentType: 'image/png',
      data: coverBytes,
      caption: '视频封面参考图（L3 兜底）',
      strategy: 'L3_cover_fallback',
    }])
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      ffmpegPath,
      expect.arrayContaining(['-ss', '2', '-i', '/virtual/lesson.mp4']),
      expect.any(Object),
      expect.any(Function),
    )
    expect(fs.readFile).not.toHaveBeenCalled()
    expect(fs.rm).toHaveBeenCalledWith('/virtual/zhizhi-frames-test', { recursive: true, force: true })
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(fallbackCoverUrl, undefined)
  })

  it.each([
    { reason: 'a network rejection', respond: () => Promise.reject(new Error('Cover unreachable')) },
    { reason: 'a non-OK HTTP response', respond: () => Promise.resolve(new Response(null, { status: 404 })) },
    { reason: 'an empty body', respond: () => Promise.resolve(new Response(null)) },
  ])('returns no assets when the cover encounters $reason', async ({ respond }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(respond)
    const extractor = new FfmpegKeyframeExtractor({ ffmpegPath, fetchImpl })

    await expect(extractor.extractKeyframes(request)).resolves.toEqual([])
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      ffmpegPath,
      expect.arrayContaining(['-ss', '5', '-i', '/virtual/lesson.mp4']),
      expect.any(Object),
      expect.any(Function),
    )
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(fallbackCoverUrl, undefined)
  })
})
