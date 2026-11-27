import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  CanvasOperation,
  QuizToolType,
  SseEvent,
  TenantContext,
  UiSwitchState,
} from '@zhizhi/contracts'
import { ZhizhiError } from '@zhizhi/errors'

export type ToolCategory = 'core' | 'skill_gen_card' | `quiz_${QuizToolType}`

export interface ToolExecutionContext {
  readonly tenant: TenantContext
  readonly pinnedSlotIds: ReadonlySet<string>
  readonly emit: (event: SseEvent) => void
}

export interface RegisteredToolSpec {
  readonly name: string
  readonly label: string
  readonly category: ToolCategory
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly execute: (
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>
}

/**
 * ADR-06 后端 Pin 钉住硬拦截守卫：
 * 任何试图覆盖已钉住槽位的 canvas_op 均会被拒绝，确保用户参考卡片不被对话顶掉。
 */
export function guardCanvasOperation(
  operation: CanvasOperation,
  pinnedSlotIds: ReadonlySet<string>,
): void {
  if (pinnedSlotIds.has(operation.slotId)) {
    throw new ZhizhiError({
      code: 'SLOT_PINNED',
      message: `Slot "${operation.slotId}" is pinned by user and cannot be overwritten`,
      details: { slotId: operation.slotId },
    })
  }
}

/**
 * ADR-05 工具注册表 + 开关确定性裁剪：
 * 按每次请求的 UiSwitchState 生成 Pi Agent 原生 AgentTool[] 白名单；
 * 关闭的技能与题型工具完全不注入给 Pi Agent，消除模型误调。
 */
export class ZhizhiToolRegistry {
  private readonly tools = new Map<string, RegisteredToolSpec>()

  register(tool: RegisteredToolSpec): () => void {
    if (this.tools.has(tool.name)) {
      throw new ZhizhiError({
        code: 'CONFLICT',
        message: `Tool "${tool.name}" is already registered`,
      })
    }
    this.tools.set(tool.name, tool)
    return () => {
      if (this.tools.get(tool.name) === tool) {
        this.tools.delete(tool.name)
      }
    }
  }

  resolveActiveSpecs(switches: UiSwitchState): RegisteredToolSpec[] {
    const active: RegisteredToolSpec[] = []
    for (const tool of this.tools.values()) {
      if (this.isEnabled(tool.category, switches)) {
        active.push(tool)
      }
    }
    return active
  }

  /**
   * 兼容旧命名，返回当前生效的工具定义列表。
   */
  resolveActiveTools(switches: UiSwitchState): RegisteredToolSpec[] {
    return this.resolveActiveSpecs(switches)
  }

  /**
   * 编译为 `@earendil-works/pi-agent-core` 原生 `AgentTool[]`，绑定本次租户与画布上下文。
   */
  buildPiAgentTools(
    switches: UiSwitchState,
    execCtx: ToolExecutionContext,
  ): AgentTool[] {
    return this.resolveActiveSpecs(switches).map(spec => ({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      async execute(
        _toolCallId: string,
        rawParams: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<Record<string, unknown>>> {
        const args =
          rawParams !== null && typeof rawParams === 'object' && !Array.isArray(rawParams)
            ? (rawParams as Record<string, unknown>)
            : {}
        const result = await spec.execute(args, execCtx, signal)
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
        }
      },
    }))
  }

  private isEnabled(category: ToolCategory, switches: UiSwitchState): boolean {
    if (category === 'core') return true
    if (category === 'skill_gen_card') return switches.skillGenCard
    if (category === 'quiz_mcq') return switches.quizTools.mcq
    if (category === 'quiz_tf') return switches.quizTools.tf
    if (category === 'quiz_blank') return switches.quizTools.blank
    if (category === 'quiz_qa') return switches.quizTools.qa
    if (category === 'quiz_code_predict') return false
    return false
  }
}

/**
 * 创建内置核心工具集（kb_search / web_search / canvas_dispatch / draft_wiki_card / quiz_generate_mcq）。
 * 后续各业务域通过替换/注入真实 Service Provider 实现完整业务逻辑。
 */
export function createDefaultToolRegistry(): ZhizhiToolRegistry {
  const registry = new ZhizhiToolRegistry()

  registry.register({
    name: 'kb_search',
    label: '检索个人知识库',
    category: 'core',
    description: '优先按当前 user_id 检索个人 LLM Wiki 知识库并返回相关卡片与出处；无命中时应调用 web_search。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '中文或英文检索关键词' },
        limit: { type: 'number', description: '最大返回条数，默认 5' },
      },
      required: ['query'],
    },
    async execute(args, ctx) {
      const query = String(args['query'] ?? '')
      return {
        userId: ctx.tenant.userId,
        query,
        hits: [],
        hint: '知识库暂无命中记录，如需要外部权威信息可调用 web_search。',
      }
    },
  })

  registry.register({
    name: 'web_search',
    label: '联网搜索兜底',
    category: 'core',
    description: '当个人知识库未命中或需要最新资料时触发联网搜索，返回带 URL 出处的摘要。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '联网搜索词' },
      },
      required: ['query'],
    },
    async execute(args) {
      return {
        query: String(args['query'] ?? ''),
        results: [],
        note: 'Web search provider not configured yet.',
      }
    },
  })

  registry.register({
    name: 'canvas_dispatch',
    label: '操控页内受控卡片槽',
    category: 'core',
    description: '向当前预设情境页的未钉住槽位投放白名单预设卡片；严禁覆盖已钉住槽位。',
    parameters: {
      type: 'object',
      properties: {
        slotId: { type: 'string', description: '目标槽位 ID，例如 slot_b' },
        cardType: {
          type: 'string',
          enum: ['wiki_card_viewer', 'wiki_draft_diff', 'source_md_preview', 'quiz_mcq_card', 'mini_graph_card'],
        },
        title: { type: 'string' },
        payload: { type: 'object' },
      },
      required: ['slotId', 'cardType', 'title'],
    },
    async execute(args, ctx) {
      const slotId = String(args['slotId'] ?? 'slot_b')
      const cardType = String(args['cardType'] ?? 'wiki_card_viewer') as CanvasOperation & { op: 'mount_card' } extends {
        cardType: infer T
      }
        ? T
        : 'wiki_card_viewer'
      const op: CanvasOperation = {
        op: 'mount_card',
        slotId,
        cardType,
        title: String(args['title'] ?? '知识卡'),
        payload: (args['payload'] as Record<string, unknown> | undefined) ?? {},
      }
      guardCanvasOperation(op, ctx.pinnedSlotIds)
      ctx.emit({ type: 'canvas_op', operation: op })
      return { ok: true, slotId }
    },
  })

  registry.register({
    name: 'draft_wiki_card',
    label: '生成知识卡草稿',
    category: 'skill_gen_card',
    description: '先查重再生成标准 Markdown 知识卡草稿并投递至画布预览；仅当用户显式点击保存时正式入库。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '知识卡标题' },
        summary: { type: 'string', description: '核心要点摘要' },
      },
      required: ['title', 'summary'],
    },
    async execute(args, ctx) {
      const title = String(args['title'] ?? '新知识卡草稿')
      const summary = String(args['summary'] ?? '')
      const targetSlot = ctx.pinnedSlotIds.has('slot_b') ? 'slot_c' : 'slot_b'
      const op: CanvasOperation = {
        op: 'mount_card',
        slotId: targetSlot,
        cardType: 'wiki_draft_diff',
        title: `草稿预览：${title}`,
        payload: { title, summary, requiresUserSave: true },
      }
      guardCanvasOperation(op, ctx.pinnedSlotIds)
      ctx.emit({ type: 'canvas_op', operation: op })
      return { ok: true, slotId: targetSlot, requiresUserSave: true }
    },
  })

  registry.register({
    name: 'quiz_generate_mcq',
    label: '生成选择题卡片',
    category: 'quiz_mcq',
    description: '围绕指定知识卡或主题生成 1 道高质量选择题（含解析）并投递至未钉住画布槽位。',
    parameters: {
      type: 'object',
      properties: {
        dimension: { type: 'string', enum: ['understanding', 'scenario_prediction'] },
        topic: { type: 'string', description: '考察主题或知识卡标题' },
      },
      required: ['dimension'],
    },
    async execute(args, ctx) {
      const dimension = args['dimension'] === 'scenario_prediction' ? 'scenario_prediction' : 'understanding'
      const targetSlot = ctx.pinnedSlotIds.has('slot_b') ? 'slot_c' : 'slot_b'
      const question = {
        kind: 'mcq',
        multiple: false,
        dimension,
        stem: '为什么知枝要求原始来源先经 AI 解析子循环转为 Standard Markdown 再进入主循环？',
        options: [
          { key: 'A', text: '仅为了减少前端代码行数' },
          { key: 'B', text: '隔离复杂解析噪声，防止拉低主 Agent 对话与制卡质量' },
          { key: 'C', text: '因为大模型不能直接读取 Markdown' },
          { key: 'D', text: '为了强制所有用户使用 Docker' },
        ],
        correctKeys: ['B'],
        explanation: '解析子循环前置完成表格重排、图片入库与去噪，经 Schema 校验后主循环只消费干净的标准 Markdown。',
      }
      const op: CanvasOperation = {
        op: 'mount_card',
        slotId: targetSlot,
        cardType: 'quiz_mcq_card',
        title: `知返 · 选择题（${dimension === 'understanding' ? '认知理解' : '情境应用预测'}）`,
        payload: question,
      }
      guardCanvasOperation(op, ctx.pinnedSlotIds)
      ctx.emit({ type: 'canvas_op', operation: op })
      return { ok: true, slotId: targetSlot, question }
    },
  })

  return registry
}
