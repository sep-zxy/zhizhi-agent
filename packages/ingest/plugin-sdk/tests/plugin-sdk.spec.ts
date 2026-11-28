import { describe, expect, it, vi } from 'vitest'
import { mintPluginId, mintUserId } from '@zhizhi/brand'
import { StandardMarkdownDocumentSchema, type StandardAssetRef } from '@zhizhi/contracts'
import {
  buildAndValidateStandardMarkdown,
  SourcePluginRegistry,
  type RawIngestInput,
  type SourcePlugin,
} from '@zhizhi/plugin-sdk'

function videoPlugin(pluginSlug: string, overrides: Partial<SourcePlugin> = {}): SourcePlugin {
  return {
    pluginId: mintPluginId(pluginSlug),
    displayName: pluginSlug,
    mode: 'in_process',
    supportedTypes: ['video_note'],
    needsSubLoop: true,
    healthcheck: async () => ({ ok: true }),
    preflight: async () => ({ estimatedChars: 0, requiresSubLoop: true }),
    extract: async () => ({ title: '示例视频', originKind: 'video', originLabel: '测试来源', anchors: [], rawBody: '字幕' }),
    ...overrides,
  }
}

describe('SourcePluginRegistry', () => {
  it('uses match() ahead of that plugin’s URL patterns for Douyin share text', () => {
    const registry = new SourcePluginRegistry()
    const rawText = '7.21 复制打开抖音，看看【示例作者的作品】 https://v.douyin.com/Example/ 9@8.cn'
    const input: RawIngestInput = { sourceType: 'video_note', rawText }
    const match = vi.fn((candidate: RawIngestInput) =>
      Boolean(candidate.rawText?.includes('复制打开抖音') && candidate.rawText.includes('v.douyin.com/')),
    )
    const douyin = videoPlugin('douyin', { match, urlPatterns: [/www\.douyin\.com\/video\//] })
    const generic = videoPlugin('generic-video', { urlPatterns: [/v\.douyin\.com\//] })
    registry.register(douyin)
    registry.register(generic)

    expect(registry.resolveForInput(input)).toBe(douyin)
    expect(match).toHaveBeenCalledExactlyOnceWith(input)
  })

  it('falls back to another plugin’s URL patterns when the custom matcher declines', () => {
    const registry = new SourcePluginRegistry()
    const urlPattern = /www\.douyin\.com\/video\//
    const custom = videoPlugin('douyin-share', { match: () => false, urlPatterns: [urlPattern] })
    const byUrl = videoPlugin('douyin-url', { urlPatterns: [urlPattern] })
    const url = 'https://www.douyin.com/video/123'
    registry.register(custom)
    registry.register(byUrl)

    expect(registry.resolveForInput({ sourceType: 'video_note', url })).toBe(byUrl)
    expect(() => registry.resolveForInput({ sourceType: 'web_article', url }))
      .toThrow(expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE' }))
  })

  it('does not resolve a plugin after its disposer runs', () => {
    const registry = new SourcePluginRegistry()
    const plugin = videoPlugin('disposable', { urlPatterns: [/video\.example\.test\//] })
    const input: RawIngestInput = { sourceType: 'video_note', url: 'https://video.example.test/123' }
    const dispose = registry.register(plugin)
    expect(registry.resolveForInput(input)).toBe(plugin)

    dispose()

    expect(() => registry.resolveForInput(input))
      .toThrow(expect.objectContaining({ name: 'ZhizhiError', code: 'PLUGIN_UNAVAILABLE' }))
    expect(registry.list()).toEqual([])
  })

  it('reports a thrown healthcheck as unhealthy without suppressing other plugins', async () => {
    const registry = new SourcePluginRegistry()
    const broken = videoPlugin('broken', {
      healthcheck: async () => { throw new Error('Provider offline') },
    })
    const working = videoPlugin('working')
    registry.register(broken)
    registry.register(working)

    await expect(registry.inspectHealth()).resolves.toMatchObject([
      { pluginId: broken.pluginId, ok: false, detail: 'Provider offline' },
      { pluginId: working.pluginId, ok: true },
    ])
  })
})

describe('buildAndValidateStandardMarkdown', () => {
  const bundle = {
    title: '示例视频',
    originKind: 'video',
    originLabel: '测试来源',
    originUrl: 'https://video.example.test/123',
    anchors: ['00:12'],
    rawBody: '原始字幕',
  }
  const params = {
    tenant: { userId: mintUserId(), role: 'user' },
    pluginId: mintPluginId('video'),
    sourceType: 'video_note',
    bundle,
    bodyMarkdown: '## 概要\n\n清洗后的正文。',
  } satisfies Parameters<typeof buildAndValidateStandardMarkdown>[0]

  it('preserves custom asset references in frontmatter and returns valid StandardMarkdown', () => {
    const assets: readonly StandardAssetRef[] = [
      { id: 'frame-1', url: '/assets/frame-1.jpg', caption: '画面说明', timestampSec: 12.5 },
      { id: 'cover', url: '/assets/cover.png' },
    ]

    const document = buildAndValidateStandardMarkdown({ ...params, assets })

    expect(document.frontmatter.assets).toStrictEqual(assets)
    expect(document.frontmatter.userId).toBe(params.tenant.userId)
    expect(document.bodyMarkdown).toBe(params.bodyMarkdown)
    expect(StandardMarkdownDocumentSchema.safeParse(document).success).toBe(true)
  })

  it('rejects a negative asset timestamp through the runtime schema', () => {
    expect(() => buildAndValidateStandardMarkdown({
      ...params,
      assets: [{ id: 'frame-1', url: '/assets/frame-1.jpg', timestampSec: -0.5 }],
    })).toThrow(expect.objectContaining({ name: 'ZhizhiError', code: 'SCHEMA_INVALID' }))
  })
})
