import { mintSourceId, type PluginId } from '@zhizhi/brand'
import type { AsrMediaSource, AsrProvider, TranscriptSegment } from '@zhizhi/cap-asr'
import type { McpClientHandle } from '@zhizhi/cap-mcp-client'
import type { KeyframeExtractor } from '@zhizhi/cap-media-frames'
import {
  StandardMarkdownDocumentSchema,
  type SourceType,
  type StandardAssetRef,
  type StandardMarkdownDocument,
  type TenantContext,
} from '@zhizhi/contracts'
import { ZhizhiError } from '@zhizhi/errors'

export type PluginMountMode = 'in_process' | 'mcp'

export type IngestStage =
  | 'matching'
  | 'fetching_meta'
  | 'downloading_media'
  | 'transcribing'
  | 'extracting_frames'
  | 'storing_assets'
  | 'sub_loop'

export interface RawIngestInput {
  readonly sourceType: SourceType
  readonly titleHint?: string
  readonly url?: string
  readonly mimeType?: string
  readonly rawText?: string
  readonly rawBytes?: Uint8Array
  readonly metadata?: Record<string, unknown>
}

export interface PreflightEstimate {
  readonly estimatedChars: number
  readonly requiresSubLoop: boolean
  readonly warningMessage?: string
}

export interface RawBinaryAsset {
  readonly name: string
  readonly contentType: string
  readonly data: Uint8Array
  readonly caption?: string
  readonly timestampSec?: number
}

export interface RawExtractedBundle {
  readonly title: string
  readonly originKind: string
  readonly originLabel: string
  readonly originUrl?: string
  readonly anchors: string[]
  readonly rawBody: string
  readonly candidateTopics?: string[]
  readonly binaryAssets?: RawBinaryAsset[]
  readonly transcript?: readonly TranscriptSegment[]
  readonly mediaRef?: AsrMediaSource
  readonly fallbackCoverUrl?: string
  readonly needsAsr?: boolean
  readonly needsKeyframes?: boolean
}

export interface SharedIngestCapabilities {
  readonly asr?: AsrProvider
  readonly keyframes?: KeyframeExtractor
  readonly mcpClients?: ReadonlyMap<string, McpClientHandle>
}

export interface PluginExtractRuntime {
  readonly signal?: AbortSignal
  readonly onProgress?: (stage: IngestStage, percent: number, detail?: string) => Promise<void> | void
  readonly capabilities?: SharedIngestCapabilities
}

/**
 * ADR-02 插槽式知识来源插件接口（支持进程内插件与外部 MCP Server 双模式）。
 */
export interface SourcePlugin {
  readonly pluginId: PluginId
  readonly displayName: string
  readonly mode: PluginMountMode
  readonly supportedTypes: readonly SourceType[]
  readonly urlPatterns?: readonly RegExp[]
  readonly mimeTypes?: readonly string[]
  readonly needsSubLoop: boolean

  match?(input: RawIngestInput): boolean
  healthcheck(): Promise<{ ok: boolean; detail?: string }>
  preflight(input: RawIngestInput, tenant: TenantContext): Promise<PreflightEstimate>
  extract(
    input: RawIngestInput,
    tenant: TenantContext,
    runtime?: PluginExtractRuntime,
  ): Promise<RawExtractedBundle>
}

export interface SourcePluginSummary {
  readonly pluginId: PluginId
  readonly displayName: string
  readonly mode: PluginMountMode
  readonly supportedTypes: readonly SourceType[]
  readonly needsSubLoop: boolean
}

export interface SourcePluginHealthReport extends SourcePluginSummary {
  readonly ok: boolean
  readonly detail?: string
}

/**
 * 可拆卸来源插件注册表（参考 DSH 注册即 effect、返回 disposer 规范）。
 */
export class SourcePluginRegistry {
  private readonly plugins = new Map<PluginId, SourcePlugin>()

  register(plugin: SourcePlugin): () => void {
    if (this.plugins.has(plugin.pluginId)) {
      throw new ZhizhiError({
        code: 'CONFLICT',
        message: `Source plugin "${plugin.pluginId}" is already registered`,
      })
    }
    this.plugins.set(plugin.pluginId, plugin)
    return () => {
      if (this.plugins.get(plugin.pluginId) === plugin) {
        this.plugins.delete(plugin.pluginId)
      }
    }
  }

  get(pluginId: PluginId): SourcePlugin {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new ZhizhiError({
        code: 'PLUGIN_UNAVAILABLE',
        message: `Source plugin "${pluginId}" is not installed or currently disabled`,
      })
    }
    return plugin
  }

  list(): SourcePluginSummary[] {
    return [...this.plugins.values()].map(p => ({
      pluginId: p.pluginId,
      displayName: p.displayName,
      mode: p.mode,
      supportedTypes: p.supportedTypes,
      needsSubLoop: p.needsSubLoop,
    }))
  }

  async inspectHealth(): Promise<SourcePluginHealthReport[]> {
    const reports: SourcePluginHealthReport[] = []
    for (const plugin of this.plugins.values()) {
      try {
        const health = await plugin.healthcheck()
        reports.push({
          pluginId: plugin.pluginId,
          displayName: plugin.displayName,
          mode: plugin.mode,
          supportedTypes: plugin.supportedTypes,
          needsSubLoop: plugin.needsSubLoop,
          ok: health.ok,
          ...(health.detail !== undefined ? { detail: health.detail } : {}),
        })
      } catch (err) {
        reports.push({
          pluginId: plugin.pluginId,
          displayName: plugin.displayName,
          mode: plugin.mode,
          supportedTypes: plugin.supportedTypes,
          needsSubLoop: plugin.needsSubLoop,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return reports
  }

  resolveForInput(input: RawIngestInput): SourcePlugin {
    const candidateText = [input.url, input.rawText].filter((v): v is string => Boolean(v)).join('\n')

    for (const plugin of this.plugins.values()) {
      if (!plugin.supportedTypes.includes(input.sourceType)) continue
      if (plugin.match) {
        if (!plugin.match(input)) continue
        return plugin
      }
      if (plugin.urlPatterns && plugin.urlPatterns.length > 0) {
        if (!candidateText || !plugin.urlPatterns.some(re => re.test(candidateText))) continue
      }
      if (input.mimeType && plugin.mimeTypes && plugin.mimeTypes.length > 0) {
        if (!plugin.mimeTypes.includes(input.mimeType)) continue
      }
      return plugin
    }
    throw new ZhizhiError({
      code: 'PLUGIN_UNAVAILABLE',
      message: `No active source plugin matches sourceType="${input.sourceType}"`,
    })
  }
}

/**
 * ADR-03 统一 Markdown 中间层封装与运行时 Schema 强校验。
 * 任何插件/子循环产出都必须通过此校验后才能流向下游三出口与主 Agent 循环。
 */
export function buildAndValidateStandardMarkdown(params: {
  readonly tenant: TenantContext
  readonly pluginId: PluginId
  readonly sourceType: SourceType
  readonly bundle: RawExtractedBundle
  readonly bodyMarkdown: string
  readonly assets?: readonly StandardAssetRef[]
  readonly subLoopModel?: string
  readonly tokensUsed?: number
}): StandardMarkdownDocument {
  const candidate = {
    frontmatter: {
      schemaVersion: '1.0' as const,
      sourceId: mintSourceId(),
      userId: params.tenant.userId,
      pluginId: params.pluginId,
      sourceType: params.sourceType,
      title: params.bundle.title,
      originRef: {
        kind: params.bundle.originKind,
        label: params.bundle.originLabel,
        ...(params.bundle.originUrl !== undefined ? { url: params.bundle.originUrl } : {}),
        anchors: params.bundle.anchors,
      },
      assets: params.assets ? [...params.assets] : [],
      parseTrace: {
        ...(params.subLoopModel !== undefined ? { subLoopModel: params.subLoopModel } : {}),
        tokensUsed: params.tokensUsed ?? 0,
        parsedAt: new Date().toISOString(),
      },
    },
    bodyMarkdown: params.bodyMarkdown,
    candidateTopics: params.bundle.candidateTopics ?? [],
  }

  const parsed = StandardMarkdownDocumentSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new ZhizhiError({
      code: 'SCHEMA_INVALID',
      message: 'StandardMarkdown validation failed at intermediate layer',
      details: { issues: parsed.error.issues },
    })
  }
  return parsed.data
}
