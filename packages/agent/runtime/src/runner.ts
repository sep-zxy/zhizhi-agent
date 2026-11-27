import { Agent, type AgentEvent, type AgentMessage } from '@earendil-works/pi-agent-core'
import { PI_AI_VERSION, type AssistantMessage, type TextContent } from '@earendil-works/pi-ai'
import type {
  ChatTurnRequest,
  PageScene,
  SseEvent,
  TenantContext,
} from '@zhizhi/contracts'
import { ZhizhiError } from '@zhizhi/errors'
import {
  createPiStreamFn,
  resolvePiModelTarget,
  type ModelRouteSpec,
  type ResolvedModelTarget,
} from './models.ts'
import { type ZhizhiToolRegistry } from './tools.ts'

export interface AgentRuntimeMetadata {
  readonly engine: 'pi-agent-core'
  readonly piAgentAvailable: boolean
  readonly piAiVersion: string
  readonly defaultMode: 'live-llm' | 'pi-faux'
}

export function inspectPiAgentRuntime(env: NodeJS.ProcessEnv = process.env): AgentRuntimeMetadata {
  const hasLiveKey = Boolean(env['DEEPSEEK_API_KEY']?.trim() || env['OPENAI_API_KEY']?.trim())
  return {
    engine: 'pi-agent-core',
    piAgentAvailable: typeof Agent === 'function',
    piAiVersion: PI_AI_VERSION,
    defaultMode: hasLiveKey ? 'live-llm' : 'pi-faux',
  }
}

export function buildMainLoopSystemPrompt(params: {
  readonly tenant: TenantContext
  readonly pageScene: PageScene
  readonly pinnedSlotIds: readonly string[]
  readonly activeToolNames: readonly string[]
}): string {
  return [
    '你是知枝（Zhizhi）的个人知识库 Agent。',
    `当前租户隔离标识：${params.tenant.userId}（严禁访问或假设其他账号数据）。`,
    `当前用户所在预设情境页：${params.pageScene}。`,
    `当前已被用户「钉住（Pin）」不可覆盖的画布槽位：${params.pinnedSlotIds.length > 0 ? params.pinnedSlotIds.join(', ') : '无'}。`,
    `本轮允许调用的工具白名单：${params.activeToolNames.join(', ')}。`,
    '行为准则：',
    '1. 回答问题前自主判断是否应调用 kb_search 检索个人知识库；命中时严格依据知识库内容并标注出处；未命中则调用 web_search 联网兜底，不编造事实。',
    '2. 仅当 draft_wiki_card 出现在工具白名单中时，才允许生成知识卡草稿；任何知识卡修改都必须由用户预览并点击保存才正式生效。',
    '3. 出题仅允许调用白名单中开启的题型工具，且向画布投放卡片时必须避开已钉住的槽位。',
  ].join('\n')
}

export interface RunAgentTurnParams {
  readonly tenant: TenantContext
  readonly sessionId: string
  readonly request: ChatTurnRequest
  readonly history?: readonly AgentMessage[]
  readonly registry: ZhizhiToolRegistry
  readonly modelRoute?: ModelRouteSpec
  readonly maxTurns?: number
  readonly signal?: AbortSignal
  readonly emit: (event: SseEvent) => void
}

export interface RunAgentTurnResult {
  readonly sessionId: string
  readonly activeTools: string[]
  readonly modelId: string
  readonly provider: string
  readonly isFaux: boolean
  readonly finalText: string
  readonly messages: AgentMessage[]
}

/**
 * 基于 `@earendil-works/pi-agent-core` 的真实主循环执行器：
 * 1. 按 UI 开关动态编译 Pi Agent 原生 `AgentTool[]` 白名单
 * 2. 在 `beforeToolCall` 钩子强制校验 Pin 槽位保护与工具白名单二次防线
 * 3. 通过 `agent.subscribe()` 将 Pi Agent 生命周期事件实时桥接为双通道 SSE（text_delta / tool_* / canvas_op / done）
 * 4. 限制最大轮次防止工具死循环
 */
export async function runPiAgentTurn(params: RunAgentTurnParams): Promise<RunAgentTurnResult> {
  const target: ResolvedModelTarget = resolvePiModelTarget(params.modelRoute)
  const pinnedSet = new Set(params.request.pinnedSlotIds)
  const activeSpecs = params.registry.resolveActiveSpecs(params.request.switches)
  const activeNames = activeSpecs.map(s => s.name)
  const activeNameSet = new Set(activeNames)

  const piTools = params.registry.buildPiAgentTools(params.request.switches, {
    tenant: params.tenant,
    pinnedSlotIds: pinnedSet,
    emit: params.emit,
  })

  const systemPrompt = buildMainLoopSystemPrompt({
    tenant: params.tenant,
    pageScene: params.request.pageScene,
    pinnedSlotIds: params.request.pinnedSlotIds,
    activeToolNames: activeNames,
  })

  const maxTurns = params.maxTurns ?? 6
  let turnCount = 0

  const agent = new Agent({
    sessionId: params.sessionId,
    streamFn: createPiStreamFn(target),
    initialState: {
      systemPrompt,
      model: target.model,
      thinkingLevel: 'off',
      tools: piTools,
      ...(params.history && params.history.length > 0 ? { messages: [...params.history] } : {}),
    },
    async beforeToolCall(context) {
      const toolName = context.toolCall.name
      if (!activeNameSet.has(toolName)) {
        return {
          block: true,
          reason: `Tool "${toolName}" is disabled by current user switches.`,
        }
      }
      if (toolName === 'canvas_dispatch' && context.args !== null && typeof context.args === 'object') {
        const slotId = (context.args as Record<string, unknown>)['slotId']
        if (typeof slotId === 'string' && pinnedSet.has(slotId)) {
          return {
            block: true,
            reason: `Slot "${slotId}" is pinned by user and cannot be overwritten.`,
          }
        }
      }
      return undefined
    },
    finishTurn() {
      turnCount += 1
      if (turnCount >= maxTurns) {
        return { action: 'end' }
      }
      return undefined
    },
  })

  if (params.signal) {
    if (params.signal.aborted) {
      agent.abort()
    } else {
      params.signal.addEventListener('abort', () => {
        agent.abort()
      }, { once: true })
    }
  }

  let streamedText = ''

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case 'message_update': {
        const sub = event.assistantMessageEvent
        if (sub.type === 'text_delta' && sub.delta.length > 0) {
          streamedText += sub.delta
          params.emit({ type: 'text_delta', delta: sub.delta })
        }
        break
      }
      case 'tool_execution_start': {
        params.emit({
          type: 'tool_start',
          toolName: event.toolName,
          callId: event.toolCallId,
        })
        break
      }
      case 'tool_execution_end': {
        params.emit({
          type: 'tool_end',
          toolName: event.toolName,
          callId: event.toolCallId,
          ok: !event.isError,
        })
        break
      }
      case 'agent_start':
      case 'agent_end':
      case 'turn_start':
      case 'turn_end':
      case 'message_start':
      case 'message_end':
      case 'tool_execution_update':
        break
    }
  })

  try {
    await agent.prompt(params.request.message)
    await agent.waitForIdle()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    params.emit({ type: 'error', code: 'LLM_PROVIDER_ERROR', message })
    throw new ZhizhiError({
      code: 'LLM_PROVIDER_ERROR',
      message: `Pi Agent turn failed: ${message}`,
      cause: err,
    })
  } finally {
    unsubscribe()
  }

  const finalAssistant = [...agent.state.messages]
    .reverse()
    .find((m): m is AssistantMessage => m.role === 'assistant')

  if (finalAssistant?.stopReason === 'error') {
    const errText = finalAssistant.errorMessage ?? 'Model stream returned error'
    params.emit({ type: 'error', code: 'LLM_PROVIDER_ERROR', message: errText })
  }

  const finalText = streamedText || extractAssistantText(finalAssistant)

  params.emit({
    type: 'done',
    sessionId: params.sessionId,
    activeTools: activeNames,
  })

  return {
    sessionId: params.sessionId,
    activeTools: activeNames,
    modelId: target.model.id,
    provider: target.model.provider,
    isFaux: target.isFaux,
    finalText,
    messages: agent.state.messages,
  }
}

function extractAssistantText(message: AssistantMessage | undefined): string {
  if (!message) return ''
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map(block => block.text)
    .join('')
}

export interface SubLoopTaskParams {
  readonly systemPrompt: string
  readonly userPrompt: string
  readonly modelRoute?: ModelRouteSpec
  readonly maxTokens?: number
}

export interface SubLoopTaskResult {
  readonly text: string
  readonly modelId: string
  readonly provider: string
  readonly tokensUsed: number
  readonly isFaux: boolean
}

/**
 * 独立无状态 AI 子循环执行器（基于 `@earendil-works/pi-ai` `Models.completeSimple`）：
 * 用于 ADR-03 解析子循环（PDF 表格重排/Git 架构总结）与 ADR-07 异步入库出题/改卡判重，
 * 与主循环对话上下文完全隔离。
 */
export async function runPiSubLoopTask(params: SubLoopTaskParams): Promise<SubLoopTaskResult> {
  const target = resolvePiModelTarget(params.modelRoute)
  const response = await target.models.completeSimple(
    target.model,
    {
      systemPrompt: params.systemPrompt,
      messages: [
        {
          role: 'user',
          content: params.userPrompt,
          timestamp: Date.now(),
        },
      ],
    },
    {
      ...(target.apiKey !== undefined ? { apiKey: target.apiKey } : {}),
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
    },
  )

  if (response.stopReason === 'error') {
    throw new ZhizhiError({
      code: 'LLM_PROVIDER_ERROR',
      message: response.errorMessage ?? 'Pi AI sub-loop task failed',
    })
  }

  return {
    text: extractAssistantText(response),
    modelId: target.model.id,
    provider: target.model.provider,
    tokensUsed: response.usage.totalTokens,
    isFaux: target.isFaux,
  }
}
