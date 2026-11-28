import { describe, expect, it, vi } from 'vitest'
import { DisabledAsrProvider, OpenAiCompatibleAsrProvider } from '@zhizhi/cap-asr'

const mediaUrl = 'https://media.example.test/clips/lesson.mp3'
const baseUrl = 'https://asr.example.test/v1'
const audioBytes = Uint8Array.of(0xff, 0xfb, 0x90, 0x64)

function audioResponse(): Response {
  return new Response(audioBytes, { headers: { 'content-type': 'audio/mpeg' } })
}

describe('OpenAiCompatibleAsrProvider', () => {
  it('downloads remote audio, uploads multipart fields, and returns timed segments', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(Response.json({
        text: '  完整转写结果  ',
        segments: [
          { start: 0, end: 1.25, text: '  第一段  ' },
          { start: 1.25, end: 1.5, text: '  ' },
          { start: 1.5, end: 3.7, text: '第二段' },
        ],
      }))
    const provider = new OpenAiCompatibleAsrProvider({
      providerId: 'test-asr',
      baseUrl: `${baseUrl}/`,
      apiKey: 'test-key',
      model: 'test-whisper',
      fetchImpl,
    })
    const downloadHeaders = { Referer: 'https://media.example.test/' }

    await expect(provider.transcribe({
      media: { kind: 'audio', remoteUrl: mediaUrl, downloadHeaders },
      languageHint: 'zh',
    })).resolves.toEqual({
      providerId: 'test-asr',
      fullText: '完整转写结果',
      segments: [
        { startSec: 0, endSec: 1.25, text: '第一段' },
        { startSec: 1.5, endSec: 3.7, text: '第二段' },
      ],
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenNthCalledWith(1, mediaUrl, { headers: downloadHeaders })
    const [url, init] = fetchImpl.mock.calls[1] ?? []
    expect(url).toBe(`${baseUrl}/audio/transcriptions`)
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer test-key')
    expect(headers.has('content-type')).toBe(false)
    expect(headers.has('referer')).toBe(false)

    const form = init?.body
    if (!(form instanceof FormData)) throw new Error('Expected multipart FormData')
    expect(form.get('model')).toBe('test-whisper')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('language')).toBe('zh')
    const file = form.get('file')
    if (!(file instanceof File)) throw new Error('Expected an audio file in the multipart body')
    expect(file.name).toBe('source.mp3')
    expect(file.type).toBe('audio/mpeg')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audioBytes)
  })

  it('builds fullText from segments when the response has no top-level text', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(audioResponse())
      .mockResolvedValueOnce(Response.json({
        segments: [
          { start: 0, end: 1, text: '  第一段' },
          { start: 1, end: 2, text: '第二段  ' },
        ],
      }))
    const provider = new OpenAiCompatibleAsrProvider({ baseUrl, apiKey: 'test-key', model: 'test-whisper', fetchImpl })

    await expect(provider.transcribe({ media: { kind: 'audio', remoteUrl: mediaUrl } }))
      .resolves.toMatchObject({ fullText: '第一段 第二段' })
  })

  it('rejects a blank API key before any media download or transcription request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const provider = new OpenAiCompatibleAsrProvider({ baseUrl, apiKey: '  ', model: 'test-whisper', fetchImpl })

    await expect(provider.healthcheck()).resolves.toMatchObject({ ok: false })
    await expect(provider.transcribe({ media: { kind: 'audio', remoteUrl: mediaUrl } })).rejects.toMatchObject({
      name: 'ZhizhiError',
      code: 'PLUGIN_UNAVAILABLE',
      message: 'ASR provider "openai-compatible-asr" is missing API key',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('DisabledAsrProvider', () => {
  it('reports unavailable and rejects transcription with a structured error', async () => {
    const provider = new DisabledAsrProvider()

    expect(provider.supportsTimestamps).toBe(false)
    await expect(provider.healthcheck()).resolves.toMatchObject({ ok: false })
    await expect(provider.transcribe()).rejects.toMatchObject({
      name: 'ZhizhiError',
      code: 'PLUGIN_UNAVAILABLE',
    })
  })
})
