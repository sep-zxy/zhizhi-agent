import { z } from 'zod'
import { McqQuestionPayloadSchema } from './quiz.ts'

/**
 * ADR-06 按功能分类的 6 个预设情境独立页面。
 */
export const PageSceneSchema = z.enum([
  'chat_qa',
  'search',
  'sources',
  'wiki',
  'map_radar',
  'wrong_book',
])
export type PageScene = z.infer<typeof PageSceneSchema>

/**
 * 页内受控卡片槽允许投放的预设卡片白名单。
 */
export const PresetCardTypeSchema = z.enum([
  'wiki_card_viewer',
  'wiki_draft_diff',
  'source_md_preview',
  'quiz_mcq_card',
  'mini_graph_card',
])
export type PresetCardType = z.infer<typeof PresetCardTypeSchema>

export const CanvasSlotStateSchema = z.object({
  slotId: z.string().min(1),
  cardType: PresetCardTypeSchema,
  refId: z.string().optional(),
  title: z.string().min(1),
  isPinned: z.boolean().default(false),
  payload: z.record(z.string(), z.unknown()).default({}),
  updatedAt: z.string().datetime(),
})
export type CanvasSlotState = z.infer<typeof CanvasSlotStateSchema>

/**
 * 前端常驻开关状态：直接驱动后端 Agent 主循环动态裁剪可用 Tool 白名单。
 */
export const UiSwitchStateSchema = z.object({
  skillGenCard: z.boolean().default(false),
  quizTools: z.object({
    mcq: z.boolean().default(true),
    tf: z.boolean().default(false),
    blank: z.boolean().default(false),
    qa: z.boolean().default(false),
  }).default({ mcq: true, tf: false, blank: false, qa: false }),
})
export type UiSwitchState = z.infer<typeof UiSwitchStateSchema>

export const CanvasOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('mount_card'),
    slotId: z.string().min(1),
    cardType: PresetCardTypeSchema,
    refId: z.string().optional(),
    title: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    op: z.literal('update_payload'),
    slotId: z.string().min(1),
    payloadPatch: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal('clear_slot'),
    slotId: z.string().min(1),
  }),
])
export type CanvasOperation = z.infer<typeof CanvasOperationSchema>

export const CitationSchema = z.object({
  kind: z.enum(['wiki_card', 'raw_source', 'web']),
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().optional(),
  snippet: z.string().optional(),
})
export type Citation = z.infer<typeof CitationSchema>

/**
 * 双通道 SSE 协议：同时承载自然语言流与受控画布卡片指令。
 */
export const SseEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), delta: z.string() }),
  z.object({ type: z.literal('tool_start'), toolName: z.string(), callId: z.string() }),
  z.object({ type: z.literal('tool_end'), toolName: z.string(), callId: z.string(), ok: z.boolean() }),
  z.object({ type: z.literal('citation'), citation: CitationSchema }),
  z.object({ type: z.literal('canvas_op'), operation: CanvasOperationSchema }),
  z.object({
    type: z.literal('quiz_card_ready'),
    slotId: z.string(),
    cardId: z.string(),
    question: McqQuestionPayloadSchema,
  }),
  z.object({
    type: z.literal('done'),
    sessionId: z.string(),
    activeTools: z.array(z.string()),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
])
export type SseEvent = z.infer<typeof SseEventSchema>

export const ChatTurnRequestSchema = z.object({
  sessionId: z.string().optional(),
  pageScene: PageSceneSchema.default('chat_qa'),
  message: z.string().min(1).max(8000),
  switches: UiSwitchStateSchema.default({
    skillGenCard: false,
    quizTools: { mcq: true, tf: false, blank: false, qa: false },
  }),
  pinnedSlotIds: z.array(z.string()).default([]),
  contextCardIds: z.array(z.string()).default([]),
})
export type ChatTurnRequest = z.infer<typeof ChatTurnRequestSchema>
