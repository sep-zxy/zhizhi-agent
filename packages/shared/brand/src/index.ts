declare const brandSymbol: unique symbol

/**
 * 品牌化不透明标识类型，避免不同业务实体的主键在编译期混传。
 */
export type Branded<T extends string, B extends string> = T & { readonly [brandSymbol]: B }

export type UserId = Branded<string, 'UserId'>
export type SourceId = Branded<string, 'SourceId'>
export type CardId = Branded<string, 'CardId'>
export type CardVersionId = Branded<string, 'CardVersionId'>
export type TopicId = Branded<string, 'TopicId'>
export type QuestionId = Branded<string, 'QuestionId'>
export type AttemptId = Branded<string, 'AttemptId'>
export type WrongBookId = Branded<string, 'WrongBookId'>
export type TodoId = Branded<string, 'TodoId'>
export type SessionId = Branded<string, 'SessionId'>
export type MessageId = Branded<string, 'MessageId'>
export type SlotId = Branded<string, 'SlotId'>
export type JobId = Branded<string, 'JobId'>
export type PluginId = Branded<string, 'PluginId'>

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

function randomChars(length: number): string {
  const bytes = new Uint8Array(length)
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  let out = ''
  for (let i = 0; i < length; i += 1) {
    const b = bytes[i] ?? 0
    out += ALPHABET[b % ALPHABET.length] ?? '0'
  }
  return out
}

/**
 * 跨环境（含局域网纯 HTTP 浏览器）生成带前缀的时间有序标识。
 * 规避浏览器在非 HTTPS 上下文禁用 crypto.randomUUID() 的限制。
 */
export function mintId<T extends Branded<string, string>>(prefix: string): T {
  const ts = Date.now().toString(36).padStart(9, '0')
  return `${prefix}_${ts}${randomChars(10)}` as T
}

/**
 * 将已校验的字符串窄化为指定品牌 ID。仅在 Zod / DB 边界使用。
 */
export function asBrand<T extends Branded<string, string>>(value: string): T {
  return value as T
}

export const mintUserId = (): UserId => mintId<UserId>('usr')
export const mintSourceId = (): SourceId => mintId<SourceId>('src')
export const mintCardId = (): CardId => mintId<CardId>('crd')
export const mintCardVersionId = (): CardVersionId => mintId<CardVersionId>('cvr')
export const mintTopicId = (): TopicId => mintId<TopicId>('tpc')
export const mintQuestionId = (): QuestionId => mintId<QuestionId>('qst')
export const mintAttemptId = (): AttemptId => mintId<AttemptId>('att')
export const mintWrongBookId = (): WrongBookId => mintId<WrongBookId>('wrg')
export const mintTodoId = (): TodoId => mintId<TodoId>('tdo')
export const mintSessionId = (): SessionId => mintId<SessionId>('ses')
export const mintMessageId = (): MessageId => mintId<MessageId>('msg')
export const mintSlotId = (): SlotId => mintId<SlotId>('slt')
export const mintJobId = (): JobId => mintId<JobId>('job')
export const mintPluginId = (slug: string): PluginId => asBrand<PluginId>(slug)

/**
 * 封闭联合类型穷尽性守卫。
 */
export function assertNever(value: never, context = 'Unexpected variant'): never {
  throw new Error(`${context}: ${String(value)}`)
}
