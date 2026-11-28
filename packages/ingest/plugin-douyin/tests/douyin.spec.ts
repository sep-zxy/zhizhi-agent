import { describe, expect, it, vi } from 'vitest'
import { mintUserId } from '@zhizhi/brand'
import type { TenantContext } from '@zhizhi/contracts'
import type { RawIngestInput } from '@zhizhi/plugin-sdk'
import {
  createDouyinPlugin,
  createDouyinPluginFromEnv,
  DOUYIN_PLUGIN_ID,
  extractDouyinUrlFromText,
  extractJsonObjectAfter,
  isDouyinShareInput,
} from '../src/index.ts'

const awemeId = '7700419372729168881'
const tenant: TenantContext = { userId: mintUserId(), role: 'user' }
const videoUrl = `https://www.douyin.com/video/${awemeId}`
const shortUrl = 'https://v.douyin.com/test-share/'
const sharePage = `https://www.iesdouyin.com/share/video/${awemeId}/`
const primaryFeed = `https://api5-normal-c-hl.amemv.com/aweme/v1/feed/?aweme_id=${awemeId}&aid=1128`
const backupFeed = `https://aweme.snssdk.com/aweme/v1/feed/?aweme_id=${awemeId}&aid=1128`
const h264Url = 'https://cdn.example/h264.mp4'
const h265Url = 'https://cdn.example/h265.mp4'
const videoInput: RawIngestInput = { sourceType: 'video_note', url: videoUrl }

function feed(...items: readonly (object | null)[]): Response {
  return Response.json({ aweme_list: items })
}

function ssr(...items: readonly object[]): Response {
  const data = { loaderData: { irrelevant: { foo: 1 }, 'video-detail': { videoInfoRes: { item_list: items } } } }
  return new Response(`<script>window._ROUTER_DATA = ${JSON.stringify(data)}; window.trailing = {};</script>`)
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } })
}

function stream(bitrate: number, isH265: number, url: string): object {
  return { bit_rate: bitrate, is_h265: isH265, play_addr: { url_list: [url] } }
}

function mockFetch(routes: Record<string, Response | Error>) {
  return vi.fn<typeof fetch>(async (url) => {
    const result = routes[String(url)]
    if (!result) throw new Error(`Unexpected URL: ${String(url)}`)
    if (result instanceof Error) throw result
    return result
  })
}

describe('extractDouyinUrlFromText / isDouyinShareInput', () => {
  it.each([
    ['短链分享口令', `5.89 复制打开抖音，访问【示例作品】 ${shortUrl}。`, shortUrl],
    ['视频长链', `${videoUrl}）`, videoUrl],
    ['图文长链', `https://www.douyin.com/note/${awemeId}`, `https://www.douyin.com/note/${awemeId}`],
    ['精选页链接', `https://www.douyin.com/jingxuan?modal_id=${awemeId}！`, `https://www.douyin.com/jingxuan?modal_id=${awemeId}`],
    ['移动分享页', `https://m.douyin.com/share/note/${awemeId}/`, `https://m.douyin.com/share/note/${awemeId}/`],
    ['iesdouyin 分享页', `${sharePage}】`, sharePage],
    ['跳过无效链接', `https://example.com/video/123 https://www.douyin.com/video/no-id ${shortUrl}`, shortUrl],
  ])('识别%s', (_name, text, expected) => {
    expect(extractDouyinUrlFromText(text)).toBe(expected)
    expect(isDouyinShareInput({ sourceType: 'video_note', rawText: text })).toBe(true)
  })

  it.each([
    '没有链接的文字',
    'https://www.example.com/note/123',
    'https://www.douyin.com.evil.example/video/123',
    'https://evil@example.com/video/123',
    'https://example.com@www.douyin.com/video/123',
    'https://www.douyin.com:8080/video/123',
    'https://www.douyin.com/jingxuan?modal_id=123fake',
  ])('拒绝无效链接 %s', (text) => {
    expect(extractDouyinUrlFromText(text)).toBeUndefined()
    expect(isDouyinShareInput({ sourceType: 'video_note', url: text })).toBe(false)
  })
})

describe('extractJsonObjectAfter', () => {
  it('扫描嵌套对象，忽略字符串中的花括号与转义', () => {
    const json = JSON.stringify({ nested: [{ label: '结束 } 与 "引号"，反斜杠 \\' }], after: { x: 1 } })
    const html = `<script>/* _ROUTER_DATA hint */ window._ROUTER_DATA = ${json}; const other = {};</script>`
    expect(extractJsonObjectAfter(html, '_ROUTER_DATA')).toBe(json)
    expect(extractJsonObjectAfter(`{"_ROUTER_DATA": ${json}, "trailing": true}`, '_ROUTER_DATA')).toBe(json)
  })

  it('拒绝缺少标志或不完整的 JSON 对象', () => {
    expect(extractJsonObjectAfter('<script>const foo = {}</script>', '_ROUTER_DATA')).toBeUndefined()
    expect(extractJsonObjectAfter('_ROUTER_DATA = {"outer": {"inner": 1}', '_ROUTER_DATA')).toBeUndefined()
  })
})

describe('DouyinSourcePlugin', () => {
  it('注册为免配置进程内来源，健康检查和预检不访问网络', async () => {
    const fetchImpl = mockFetch({})
    const plugin = createDouyinPlugin({ fetchImpl })
    expect(plugin).toMatchObject({ pluginId: DOUYIN_PLUGIN_ID, mode: 'in_process', supportedTypes: ['video_note'], needsSubLoop: true })
    await expect(plugin.healthcheck()).resolves.toEqual({
      ok: true, detail: 'In-process Douyin parser ready (mobile-feed + iesdouyin-ssr)',
    })
    await expect(plugin.preflight(videoInput, tenant)).resolves.toMatchObject({ requiresSubLoop: true })
    await expect(plugin.preflight({ sourceType: 'video_note' }, tenant)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(plugin.extract({ sourceType: 'video_note' }, tenant)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('手动展开短链，精准匹配主 Feed，并选择最高码率 H.264、归一化时长与 metadata', async () => {
    const fetchImpl = mockFetch({
      [shortUrl]: redirect(videoUrl),
      [primaryFeed]: feed(null, { aweme_id: `${awemeId}0`, desc: '无关的推荐作品' }, {
        aweme_id: awemeId,
        desc: '如何学习 TypeScript？\n这是正文。',
        author: { nickname: '示例作者' },
        statistics: { digg_count: 42, collect_count: 7, comment_count: 0, share_count: 9 },
        text_extra: [{ hashtag_name: ' TypeScript ' }, {}, { hashtag_name: '编程' }],
        video_tag: [{ tag_name: '#TypeScript' }, { tag_name: '学习' }],
        video: {
          duration: 177934,
          bit_rate: [stream(500, 0, 'https://cdn.example/low.mp4'), stream(3000, 1, h265Url), stream(1000, 0, h264Url)],
          origin_cover: { url_list: ['https://cdn.example/origin.jpg'] },
          cover: { url_list: ['https://cdn.example/cover.jpg'] },
          dynamic_cover: { url_list: ['https://cdn.example/dynamic.webp'] },
        },
        music: { play_url: { url_list: ['https://cdn.example/audio.mp3'] } },
      }),
    })
    const bundle = await createDouyinPlugin({ fetchImpl }).extract({ sourceType: 'video_note', rawText: `复制口令 ${shortUrl}` }, tenant)
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([shortUrl, primaryFeed])
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('manual')
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).has('Cookie')).toBe(false)
    expect(bundle).toMatchObject({
      originKind: 'douyin_video', originLabel: '抖音视频 · 示例作者', originUrl: videoUrl,
      candidateTopics: ['TypeScript', '编程', '学习'], fallbackCoverUrl: 'https://cdn.example/origin.jpg',
      needsAsr: true, needsKeyframes: true,
      mediaRef: { kind: 'video', remoteUrl: h264Url, durationSec: 177.93, downloadHeaders: { Referer: 'https://www.douyin.com/' } },
    })
    expect(bundle.mediaRef?.downloadHeaders?.['User-Agent']).toContain('iPhone')
    expect(bundle.anchors).toEqual([`aweme_id:${awemeId}`, 'author:示例作者', 'audio:https://cdn.example/audio.mp3', 'duration:177.93s'])
    expect(bundle.rawBody).toContain('点赞 42 · 收藏 7 · 评论 0 · 分享 9')
    expect(bundle.rawBody).toContain('这是正文。')
  })

  it('主节点不匹配时选择备用 Feed；没有 H.264 则选择最高码率 H.265', async () => {
    const fetchImpl = mockFetch({
      [primaryFeed]: feed({ aweme_id: '123', desc: '不是目标作品' }),
      [backupFeed]: feed({
        aweme_id: awemeId,
        video: {
          bit_rate: [stream(3000, 1, h265Url), stream(1000, 1, 'https://cdn.example/low.mp4')],
          duration: 98,
          cover: { url_list: ['https://cdn.example/cover.jpg'] },
          dynamic_cover: { url_list: ['https://cdn.example/dynamic.webp'] },
        },
      }),
    })
    const bundle = await createDouyinPlugin({ fetchImpl }).extract(videoInput, tenant)
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([primaryFeed, backupFeed])
    expect(bundle.mediaRef).toMatchObject({ remoteUrl: h265Url, durationSec: 98 })
    expect(bundle.fallbackCoverUrl).toBe('https://cdn.example/cover.jpg')
  })

  it('最多展开三跳，并支持相对 Location 和 modal_id', async () => {
    const next = 'https://v.douyin.com/second/'
    const last = 'https://m.douyin.com/third/'
    const fetchImpl = mockFetch({
      [shortUrl]: redirect('/second/'),
      [next]: redirect(last),
      [last]: redirect(`https://www.douyin.com/jingxuan?modal_id=${awemeId}`),
      [primaryFeed]: feed({ aweme_id: awemeId, desc: '第三跳命中' }),
    })
    const bundle = await createDouyinPlugin({ fetchImpl }).extract({ ...videoInput, url: shortUrl }, tenant)
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([shortUrl, next, last, primaryFeed])
    expect(bundle.title).toBe('第三跳命中')
  })

  it.each([
    'http://127.0.0.1/video/123',
    'https://www.douyin.com.evil.example/video/123',
    'https://www.douyin.com:8443/video/123',
  ])('不请求白名单外的短链跳转 %s', async (location) => {
    const fetchImpl = mockFetch({ [shortUrl]: redirect(location) })
    const run = createDouyinPlugin({ fetchImpl }).extract({ ...videoInput, url: shortUrl }, tenant)
    await expect(run).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('短链超出三跳时停止', async () => {
    const fetchImpl = mockFetch({
      [shortUrl]: redirect('/second/'),
      'https://v.douyin.com/second/': redirect('/third/'),
      'https://v.douyin.com/third/': redirect('/fourth/'),
    })
    await expect(createDouyinPlugin({ fetchImpl }).extract({ ...videoInput, url: shortUrl }, tenant))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('主备 Feed 异常或结构无效时降级到 SSR，并清洗播放路径和清晰度', async () => {
    const fetchImpl = mockFetch({
      [primaryFeed]: new Error('primary unavailable'),
      [backupFeed]: Response.json({ aweme_list: { invalid: true } }),
      [sharePage]: ssr({
        aweme_id: awemeId,
        desc: 'SSR } 文案',
        video: {
          play_addr: { url_list: ['https://cdn.example/aweme/v1/playwm/?id=12&ratio=720p&other=720p'] },
          dynamic_cover: { url_list: ['https://cdn.example/dynamic.webp'] },
        },
      }),
    })
    const bundle = await createDouyinPlugin({ fetchImpl }).extract(videoInput, tenant)
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([primaryFeed, backupFeed, sharePage])
    expect(new Headers(fetchImpl.mock.calls[2]?.[1]?.headers).get('User-Agent')).toContain('Mobile')
    expect(bundle).toMatchObject({
      title: 'SSR } 文案',
      mediaRef: { remoteUrl: 'https://cdn.example/aweme/v1/play/?id=12&ratio=1080p&other=720p' },
      fallbackCoverUrl: 'https://cdn.example/dynamic.webp',
    })
  })

  it('可以关闭移动 Feed，遇到不同作品的 SSR 数据时显式失败', async () => {
    const fetchImpl = mockFetch({ [sharePage]: ssr({ aweme_id: '123', desc: '另一个作品' }) })
    await expect(createDouyinPlugin({ fetchImpl, enableMobileFeed: false }).extract(videoInput, tenant))
      .rejects.toMatchObject({ code: 'SCHEMA_INVALID' })
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([sharePage])
    await expect(createDouyinPluginFromEnv({ ZHIZHI_DOUYIN_ENABLE_MOBILE_FEED: 'false' }).healthcheck())
      .resolves.toMatchObject({ detail: 'In-process Douyin parser ready (iesdouyin-ssr)' })
  })

  it('第三方请求被取消时不继续尝试备用节点', async () => {
    const controller = new AbortController()
    const reason = new Error('用户取消采集')
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      controller.abort(reason)
      init?.signal?.throwIfAborted()
      throw new Error('Expected request to be aborted')
    })
    await expect(createDouyinPlugin({ fetchImpl }).extract(videoInput, tenant, { signal: controller.signal })).rejects.toBe(reason)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('尝试两种字幕字段，WebVTT 可用时用公共解析结果替代 ASR', async () => {
    const brokenUrl = 'https://cdn.example/broken.vtt'
    const subtitleUrl = 'https://cdn.example/zh.vtt'
    const fetchImpl = mockFetch({
      [primaryFeed]: feed({
        aweme_id: awemeId,
        video: {
          play_addr: { url_list: [h264Url] },
          cla_info: { caption_infos: [{ url: brokenUrl }] },
          subtitle_infos: [{ subtitle_url: subtitleUrl }],
        },
      }),
      [brokenUrl]: new Response('not a subtitle'),
      [subtitleUrl]: new Response('WEBVTT\n\n00:00:01.250 --> 00:00:03.000\n<b>原生字幕</b>\n'),
    })
    const bundle = await createDouyinPlugin({ fetchImpl }).extract(videoInput, tenant)
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([primaryFeed, brokenUrl, subtitleUrl])
    expect(bundle).toMatchObject({
      transcript: [{ startSec: 1.25, endSec: 3, text: '原生字幕' }], needsAsr: false, needsKeyframes: true,
    })
  })

  it('字幕全部失败时保留媒体流，交由公共 ASR', async () => {
    const subtitleUrl = 'https://cdn.example/missing.srt'
    const fetchImpl = mockFetch({
      [primaryFeed]: feed({
        aweme_id: awemeId,
        video: { play_addr: { url_list: [h264Url] }, cla_info: { caption_infos: [{ webvtt_url: subtitleUrl }] } },
      }),
      [subtitleUrl]: new Response(null, { status: 404 }),
    })
    const bundle = await createDouyinPlugin({ fetchImpl }).extract(videoInput, tenant)
    expect(bundle.transcript).toBeUndefined()
    expect(bundle.needsAsr).toBe(true)
    expect(bundle.mediaRef?.remoteUrl).toBe(h264Url)
  })

  it.each(['images', 'image_post_info'])('识别 %s 图文，下载末项原图，限制数量并跳过 ASR 和抽帧', async (field) => {
    const first = 'https://cdn.example/1-original.png'
    const second = 'https://cdn.example/2-original.webp'
    const images = [
      { url_list: ['https://cdn.example/1-watermarked.png', first] },
      { url_list: ['https://cdn.example/2-watermarked.webp', second] },
      { url_list: ['https://cdn.example/3-original.jpg'] },
    ]
    const fetchImpl = mockFetch({
      [sharePage]: ssr({ aweme_id: awemeId, [field]: field === 'images' ? images : { images }, video: { duration: 88 } }),
      [first]: new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'image/png' } }),
      [second]: new Response(new Uint8Array([3]), { headers: { 'Content-Type': 'image/webp' } }),
    })
    const plugin = createDouyinPlugin({ fetchImpl, maxGalleryImages: 2, enableMobileFeed: false })
    const note = `https://www.douyin.com/note/${awemeId}`
    const bundle = await plugin.extract({ ...videoInput, url: note, titleHint: '图文标题' }, tenant)
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([sharePage, first, second])
    expect(bundle).toMatchObject({
      title: '图文标题', originKind: 'douyin_gallery', originUrl: note, needsAsr: false, needsKeyframes: false,
      binaryAssets: [
        { name: 'douyin-gallery-1.png', contentType: 'image/png', data: new Uint8Array([1, 2]) },
        { name: 'douyin-gallery-2.webp', contentType: 'image/webp', data: new Uint8Array([3]) },
      ],
    })
    expect(bundle.mediaRef).toBeUndefined()
  })
})
