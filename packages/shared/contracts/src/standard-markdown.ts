import { z } from 'zod'
import type { UserId } from '@zhizhi/brand'

/**
 * 租户上下文：仅允许由服务端鉴权中间件构造并向下透传。
 */
export interface TenantContext {
  readonly userId: UserId
  readonly role: 'user' | 'admin'
}

export const SourceTypeSchema = z.enum([
  'web_article',
  'video_note',
  'local_file',
  'git_summary',
  'chat_excerpt',
])
export type SourceType = z.infer<typeof SourceTypeSchema>

export const SourceDispositionSchema = z.enum([
  'archive_only',
  'todo_queue',
  'wiki_card',
])
export type SourceDisposition = z.infer<typeof SourceDispositionSchema>

export const StandardAssetRefSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  caption: z.string().optional(),
  timestampSec: z.number().nonnegative().optional(),
})
export type StandardAssetRef = z.infer<typeof StandardAssetRefSchema>

/**
 * ADR-03 统一 Markdown 中间层运行时 Schema：
 * 任何来源在进入 Agent 主循环或统一三出口前必须通过此契约校验。
 */
export const StandardMarkdownFrontmatterSchema = z.object({
  schemaVersion: z.literal('1.0'),
  sourceId: z.string().min(1),
  userId: z.string().min(1),
  pluginId: z.string().min(1),
  sourceType: SourceTypeSchema,
  title: z.string().min(1).max(200),
  originRef: z.object({
    kind: z.string().min(1),
    label: z.string().min(1),
    url: z.string().optional(),
    anchors: z.array(z.string()).default([]),
  }),
  assets: z.array(StandardAssetRefSchema).default([]),
  parseTrace: z.object({
    subLoopModel: z.string().optional(),
    tokensUsed: z.number().int().nonnegative().default(0),
    parsedAt: z.string().datetime(),
  }),
})
export type StandardMarkdownFrontmatter = z.infer<typeof StandardMarkdownFrontmatterSchema>

export const StandardMarkdownDocumentSchema = z.object({
  frontmatter: StandardMarkdownFrontmatterSchema,
  bodyMarkdown: z.string().min(1),
  candidateTopics: z.array(z.string().min(1)).default([]),
})
export type StandardMarkdownDocument = z.infer<typeof StandardMarkdownDocumentSchema>

/**
 * ADR-04 Git 跨端采集器推数契约（严禁携带大段原始代码，仅保留架构级抽象总结）。
 */
export const GitSummaryIngestPayloadSchema = z.object({
  repoLabel: z.string().min(1).max(120),
  commitRange: z.string().min(1).max(120),
  rawCommitMessages: z.array(z.string()).min(1).max(200),
  archSummaryMarkdown: z.string().min(20),
  candidateTopics: z.array(z.string()).default([]),
})
export type GitSummaryIngestPayload = z.infer<typeof GitSummaryIngestPayloadSchema>
