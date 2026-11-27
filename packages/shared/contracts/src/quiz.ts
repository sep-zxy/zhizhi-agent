import { z } from 'zod'

/**
 * 工具化题型枚举：V1 优先交付 mcq，V1.5 扩展 tf / blank / qa / code_predict。
 */
export const QuizToolTypeSchema = z.enum([
  'mcq',
  'tf',
  'blank',
  'qa',
  'code_predict',
])
export type QuizToolType = z.infer<typeof QuizToolTypeSchema>

/**
 * ADR-07 入库默认双题考察维度：认知理解 + 实际情境应用预测。
 */
export const QuizDimensionSchema = z.enum([
  'understanding',
  'scenario_prediction',
])
export type QuizDimension = z.infer<typeof QuizDimensionSchema>

export const McqOptionSchema = z.object({
  key: z.enum(['A', 'B', 'C', 'D', 'E']),
  text: z.string().min(1),
})

export const McqQuestionPayloadSchema = z.object({
  kind: z.literal('mcq'),
  multiple: z.boolean().default(false),
  stem: z.string().min(1),
  options: z.array(McqOptionSchema).min(2).max(5),
  correctKeys: z.array(z.enum(['A', 'B', 'C', 'D', 'E'])).min(1),
  explanation: z.string().min(1),
})
export type McqQuestionPayload = z.infer<typeof McqQuestionPayloadSchema>

export const TrueFalseQuestionPayloadSchema = z.object({
  kind: z.literal('tf'),
  statement: z.string().min(1),
  answer: z.boolean(),
  explanation: z.string().min(1),
})

export const BlankQuestionPayloadSchema = z.object({
  kind: z.literal('blank'),
  prompt: z.string().min(1),
  acceptedAnswers: z.array(z.string().min(1)).min(1),
  explanation: z.string().min(1),
})

export const QaQuestionPayloadSchema = z.object({
  kind: z.literal('qa'),
  prompt: z.string().min(1),
  rubricPoints: z.array(z.string().min(1)).min(1),
  referenceAnswer: z.string().min(1),
})

export const QuestionPayloadSchema = z.discriminatedUnion('kind', [
  McqQuestionPayloadSchema,
  TrueFalseQuestionPayloadSchema,
  BlankQuestionPayloadSchema,
  QaQuestionPayloadSchema,
])
export type QuestionPayload = z.infer<typeof QuestionPayloadSchema>

/**
 * 强绑定知识卡的 1:N 题库记录契约。
 */
export const CardQuestionRecordSchema = z.object({
  id: z.string().min(1),
  cardId: z.string().min(1),
  cardVersionNo: z.number().int().positive(),
  sourceId: z.string().nullable(),
  toolType: QuizToolTypeSchema,
  dimension: QuizDimensionSchema,
  coverageSummary: z.string().min(1),
  payload: QuestionPayloadSchema,
  createdAt: z.string().datetime(),
})
export type CardQuestionRecord = z.infer<typeof CardQuestionRecordSchema>

/**
 * ADR-08 独立错题生命周期状态（与入库解耦，支持归档与删除）。
 */
export const WrongBookStatusSchema = z.enum(['active', 'archived', 'deleted'])
export type WrongBookStatus = z.infer<typeof WrongBookStatusSchema>
