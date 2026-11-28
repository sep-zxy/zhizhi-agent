import { describe, expect, it, vi } from 'vitest'
import { mintUserId } from '@zhizhi/brand'
import type { McpClientHandle, McpToolCallResult } from '@zhizhi/cap-mcp-client'
import type { TenantContext } from '@zhizhi/contracts'
import { ZhizhiError } from '@zhizhi/errors'
import {
  createDouyinDtkPlugin,
  DOUYIN_DTK_PLUGIN_ID,
  extractDouyinUrlFromText,
  isDouyinShareInput,
} from '@zhizhi/plugin-douyin-dtk'

function createMockMcp(
  handler: (name: string, args: Record<string, unknown>) => Promise<McpToolCallResult>,
): McpClientHandle {
  return {
    callTool: vi.fn((name: string, args: Record<string, unknown>) => handler(name, args)),
    listTools: vi.fn(async () => ['pool_status', 'parse_url', 'download_media', 'transcribe_video', 'get_task_result']),
    ping: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
  }
}

describe('Douyin DTK v5 MCP plugin', () => {
  const tenant: TenantContext = { userId: mintUserId(), role: 'user' }

  it('extracts Douyin URLs from share copy, short links, video pages, and modal_id links', () => {
    expect(
      extractDouyinUrlFromText(
        '2.84 nqe:/ 架构设计复盘 https://v.douyin.com/L4FJNR3/ 复制此链接，打开Dou音搜索',
      ),
    ).toBe('https://v.douyin.com/L4FJNR3/')

    expect(extractDouyinUrlFromText('https://www.douyin.com/video/7126745726494821640')).toBe(
      'https://www.douyin.com/video/7126745726494821640',
    )
    expect(extractDouyinUrlFromText('https://www.douyin.com/jingxuan?modal_id=7660875690212492466')).toBe(
      'https://www.douyin.com/jingxuan?modal_id=7660875690212492466',
    )
    expect(extractDouyinUrlFromText('https://www.bilibili.com/video/BV1xx411c7mD')).toBeUndefined()

    expect(
      isDouyinShareInput({
        sourceType: 'video_note',
        rawText: '好课分享 https://v.douyin.com/abc123/，建议收藏',
      }),
    ).toBe(true)
  })

  it('stays non-blocking in standby mode when DTK_MCP_URL is not configured', async () => {
    const plugin = createDouyinDtkPlugin()
    expect(plugin.pluginId).toBe(DOUYIN_DTK_PLUGIN_ID)

    const health = await plugin.healthcheck()
    expect(health.ok).toBe(false)
    expect(health.detail).toContain('DTK_MCP_URL')

    await expect(
      plugin.extract({ sourceType: 'video_note', url: 'https://v.douyin.com/L4FJNR3/' }, tenant),
    ).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' })
  })

  it('checks DTK identity pool via pool_status without consuming upstream quota', async () => {
    const healthyMcp = createMockMcp(async () => ({
      isError: false,
      text: '',
      json: { usable_identities: { douyin: 3 }, summary: 'douyin: 3 active' },
    }))
    expect(await createDouyinDtkPlugin({ mcpClient: healthyMcp }).healthcheck()).toEqual({
      ok: true,
      detail: 'douyin: 3 active',
    })

    const emptyPoolMcp = createMockMcp(async () => ({
      isError: false,
      text: '',
      json: { usable_identities: { douyin: 0 }, summary: 'douyin: 0 active' },
    }))
    const degraded = await createDouyinDtkPlugin({ mcpClient: emptyPoolMcp }).healthcheck()
    expect(degraded.ok).toBe(false)
    expect(degraded.detail).toContain('No active Douyin identities')
  })

  it('polls pending parse_url task, downloads video, and reuses DTK offline FunASR transcription', async () => {
    let pollCount = 0
    const mcp = createMockMcp(async (name, args) => {
      if (name === 'parse_url') {
        expect(args['url']).toBe('https://v.douyin.com/L4FJNR3/')
        return { isError: false, text: '', json: { status: 'pending', task_id: 'tsk_001' } }
      }
      if (name === 'get_task_result') {
        pollCount += 1
        return {
          isError: false,
          text: '',
          json: {
            status: 'ok',
            content_id: '7126745726494821640',
            data: {
              title: '插槽架构实践',
              desc: '讲清楚为什么能力域和插件域要分开 #架构 #Agent',
              author: { nickname: '架构笔记君' },
              video_url: 'https://cdn.example.test/video.mp4',
              cover_url: 'https://cdn.example.test/cover.jpg',
              duration: 95000,
              hashtags: ['架构', 'Agent'],
              statistics: { digg_count: 120, collect_count: 45, comment_count: 12 },
            },
          },
        }
      }
      if (name === 'download_media') {
        return {
          isError: false,
          text: '',
          json: { status: 'ok', data: { download_id: 'dl_99', local_path: '/media/7126745726494821640.mp4' } },
        }
      }
      if (name === 'transcribe_video') {
        return {
          isError: false,
          text: '',
          json: { status: 'ok', data: { text: '今天我们聊一下为什么不能把 ASR 写死在抖音插件里。' } },
        }
      }
      throw new ZhizhiError({ code: 'NOT_FOUND', message: `Unexpected tool ${name}` })
    })

    const stages: string[] = []
    const plugin = createDouyinDtkPlugin({ mcpClient: mcp, pollIntervalMs: 1 })
    const bundle = await plugin.extract(
      { sourceType: 'video_note', rawText: '分享口令 https://v.douyin.com/L4FJNR3/ 打开观看' },
      tenant,
      {
        onProgress(stage) {
          stages.push(stage)
        },
      },
    )

    expect(pollCount).toBe(1)
    expect(stages).toEqual(['fetching_meta', 'downloading_media', 'transcribing'])
    expect(bundle.originKind).toBe('douyin_video')
    expect(bundle.needsAsr).toBe(false)
    expect(bundle.needsKeyframes).toBe(true)
    expect(bundle.mediaRef?.localPath).toBe('/media/7126745726494821640.mp4')
    expect(bundle.mediaRef?.durationSec).toBe(95)
    expect(bundle.fallbackCoverUrl).toBe('https://cdn.example.test/cover.jpg')
    expect(bundle.rawBody).toContain('语音转写全文（DTK 离线 FunASR）')
    expect(bundle.candidateTopics).toEqual(['架构', 'Agent'])
  })

  it('falls back to shared AsrProvider when DTK transcriber sidecar is disabled', async () => {
    const mcp = createMockMcp(async (name) => {
      if (name === 'parse_url') {
        return {
          isError: false,
          text: '',
          json: {
            status: 'ok',
            content_id: '71260001',
            data: {
              desc: '只有视频没有开 FunASR 边车',
              author: { nickname: '作者B' },
              video_url: 'https://cdn.example.test/raw.mp4',
              duration_sec: 42,
            },
          },
        }
      }
      if (name === 'download_media') {
        return { isError: false, text: '', json: { status: 'ok', data: { download_id: 'dl_2' } } }
      }
      if (name === 'transcribe_video') {
        return { isError: true, text: 'transcriber sidecar is not running', json: undefined }
      }
      throw new Error(`unexpected ${name}`)
    })

    const plugin = createDouyinDtkPlugin({ mcpClient: mcp, pollIntervalMs: 1 })
    const bundle = await plugin.extract(
      { sourceType: 'video_note', url: 'https://www.douyin.com/video/71260001' },
      tenant,
    )

    expect(bundle.needsAsr).toBe(true)
    expect(bundle.mediaRef?.remoteUrl).toBe('https://cdn.example.test/raw.mp4')
    expect(bundle.mediaRef?.durationSec).toBe(42)
  })

  it('downloads gallery images directly and skips ASR and keyframe extraction', async () => {
    const imgBytes = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(imgBytes, { headers: { 'content-type': 'image/jpeg' } }),
    )
    const mcp = createMockMcp(async (name) => {
      if (name === 'parse_url') {
        return {
          isError: false,
          text: '',
          json: {
            status: 'ok',
            content_id: '71299999',
            data: {
              media_type: 'gallery',
              desc: '一图看懂知识库分层',
              author: { nickname: '图解君' },
              images: ['https://cdn.example.test/1.jpg', 'https://cdn.example.test/2.jpg'],
            },
          },
        }
      }
      throw new Error(`Gallery flow should not call ${name}`)
    })

    const plugin = createDouyinDtkPlugin({ mcpClient: mcp, fetchImpl })
    const bundle = await plugin.extract(
      { sourceType: 'video_note', url: 'https://www.douyin.com/note/71299999' },
      tenant,
    )

    expect(bundle.originKind).toBe('douyin_gallery')
    expect(bundle.needsAsr).toBe(false)
    expect(bundle.needsKeyframes).toBe(false)
    expect(bundle.binaryAssets).toHaveLength(2)
    expect(bundle.binaryAssets?.[0]?.name).toBe('douyin-gallery-1.jpg')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('parses real DTK v5 Content model shape (nested media, duration_ms, stats, web_url, referer, top-level download_id)', async () => {
    const mcp = createMockMcp(async (name) => {
      if (name === 'parse_url') {
        return {
          isError: false,
          text: '',
          json: {
            status: 'ok',
            task_id: 'tsk_dtk5',
            platform: 'douyin',
            resource: 'video',
            data: {
              platform: 'douyin',
              content_id: '7660875690212492466',
              kind: 'video',
              web_url: 'https://www.douyin.com/video/7660875690212492466',
              title: '真实 DTK v5 契约',
              description: '真实 DTK v5 契约\n正文补充说明',
              duration_ms: 125400,
              author: { platform: 'douyin', uid: 'MS4wLjAB_demo', nickname: 'DTK实测作者' },
              stats: { digg_count: 88, comment_count: 9, collect_count: 33, share_count: 4 },
              media: {
                covers: [{ url: 'https://p3.douyinpic.example/cover.jpeg', urls: [] }],
                video: { url: 'https://v26.douyinvod.example/clean.mp4', urls: [], watermark: false },
                streams: [],
                images: [],
                access: { referer: 'https://www.douyin.com/', session_bound: false },
              },
              tags: ['架构', 'MCP'],
            },
          },
        }
      }
      if (name === 'download_media') {
        return {
          isError: false,
          text: '',
          json: { status: 'ok', task_id: 'tsk_dl', download_id: 'dl_real_5113', data: { state: 'completed' } },
        }
      }
      if (name === 'transcribe_video') {
        return {
          isError: false,
          text: '',
          json: { status: 'ok', task_id: 'tsk_tx', transcription_id: 'tx_real_5113', data: { text: '真实模型返回转写正文' } },
        }
      }
      throw new Error(`unexpected ${name}`)
    })

    const plugin = createDouyinDtkPlugin({ mcpClient: mcp })
    const bundle = await plugin.extract(
      { sourceType: 'video_note', url: 'https://v.douyin.com/RealShape/' },
      tenant,
    )

    expect(bundle.originUrl).toBe('https://www.douyin.com/video/7660875690212492466')
    expect(bundle.mediaRef?.remoteUrl).toBe('https://v26.douyinvod.example/clean.mp4')
    expect(bundle.mediaRef?.downloadHeaders).toEqual({ Referer: 'https://www.douyin.com/' })
    expect(bundle.mediaRef?.durationSec).toBe(125.4)
    expect(bundle.fallbackCoverUrl).toBe('https://p3.douyinpic.example/cover.jpeg')
    expect(bundle.needsAsr).toBe(false)
    expect(bundle.rawBody).toContain('真实模型返回转写正文')
    expect(bundle.rawBody).toContain('点赞 88 · 收藏 33 · 评论 9')
  })
})
