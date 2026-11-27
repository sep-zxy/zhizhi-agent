import type {
  Api,
  ApiKeyAuth,
  AssistantMessage,
  Model,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai'
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxProviderHandle,
  type MutableModels,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { ZhizhiError } from '@zhizhi/errors'

export type LlmScene = 'main_loop' | 'sub_loop' | 'quiz_gen'

export interface ModelRouteSpec {
  readonly provider: string
  readonly modelId: string
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly temperature?: number
  readonly maxTokens?: number
}

export interface ResolvedModelTarget {
  readonly models: MutableModels
  readonly model: Model<Api>
  readonly apiKey?: string
  readonly isFaux: boolean
}

function buildCustomOpenAiCompatibleProvider(spec: ModelRouteSpec): Provider<'openai-completions'> {
  const providerId = spec.provider
  const baseUrl = spec.baseUrl ?? 'https://api.openai.com/v1'
  const apiKey = spec.apiKey ?? ''

  const model: Model<'openai-completions'> = {
    id: spec.modelId,
    name: spec.modelId,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: spec.maxTokens ?? 4096,
  }

  const apiKeyAuth: ApiKeyAuth = apiKey
    ? {
      name: `${providerId} API Key`,
      resolve: () => Promise.resolve({ auth: { apiKey, baseUrl }, source: 'runtime-config' }),
    }
    : envApiKeyAuth(`${providerId} API Key`, ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'])

  return createProvider({
    id: providerId,
    name: providerId,
    baseUrl,
    auth: { apiKey: apiKeyAuth },
    models: [model],
    api: openAICompletionsApi(),
  })
}

/**
 * 构建内置零 Token Faux Provider（基于 pi-ai 官方 fauxProvider，真正走完整 Pi Agent 循环与工具调用链路）。
 */
export function createDeterministicFauxProvider(): FauxProviderHandle {
  const handle = fauxProvider({
    provider: 'zhizhi-faux',
    api: 'zhizhi-faux-api',
    models: [
      {
        id: 'zhizhi-dev-mock',
        name: 'Zhizhi Deterministic Mock (Pi Agent)',
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
  })

  handle.setResponses([
    (context: TranscriptContext): AssistantMessage => {
      const last = context.messages[context.messages.length - 1]
      if (!last) {
        return fauxAssistantMessage('你好，我是运行在 Pi Agent Core 上的知枝助手。')
      }

      // 工具结果回传后，生成最终自然语言回复
      if (last.role === 'toolResult') {
        if (last.isError) {
          return fauxAssistantMessage(`工具 ${last.toolName} 执行受限：${extractText(last.content)}`)
        }
        return fauxAssistantMessage(`已完成工具 ${last.toolName} 调用，并同步更新了你的知识与画布状态。`)
      }

      // 首次用户提问：按需触发真实 Pi Agent 工具调用
      if (last.role === 'user') {
        const text = extractText(last.content)
        const systemMsg = context.messages.find(m => m.role === 'system')
        const declaredToolNames = new Set((systemMsg?.toolsAdded ?? []).map(t => t.name))

        if (/出题|选择题|练|测/.test(text) && declaredToolNames.has('quiz_generate_mcq')) {
          return fauxAssistantMessage([
            fauxText('好的，我先调用选择题工具为你生成练习题并投递到未钉住的画布槽位。'),
            fauxToolCall('quiz_generate_mcq', {
              dimension: 'understanding',
              topic: text,
            }),
          ])
        }

        if (/出题|选择题|练|测/.test(text) && !declaredToolNames.has('quiz_generate_mcq')) {
          return fauxAssistantMessage(
            '你当前关闭了「选择题」开关，Pi Agent 本轮工具白名单中不包含出题工具，因此无法出题；请先打开开关。',
          )
        }

        if (/存卡|知识卡|沉淀/.test(text) && declaredToolNames.has('draft_wiki_card')) {
          return fauxAssistantMessage([
            fauxText('已开启「生成知识卡」技能，我先查重并生成草稿供你预览确认。'),
            fauxToolCall('draft_wiki_card', {
              title: '对话沉淀知识卡草稿',
              summary: text,
            }),
          ])
        }

        if (declaredToolNames.has('kb_search')) {
          return fauxAssistantMessage([
            fauxToolCall('kb_search', { query: text }),
          ])
        }

        return fauxAssistantMessage(`已收到你的问题：“${text}”。`)
      }

      return fauxAssistantMessage('对话已完成。')
    },
  ])

  return handle
}

function extractText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
}

/**
 * 解析当前租户/场景对应的 Pi AI 模型与 Models 容器：
 * - 优先使用显式 route（来自用户多模型配置）
 * - 其次检测环境变量 DEEPSEEK_API_KEY / OPENAI_API_KEY
 * - 无密钥时自动降级到 pi-ai 官方 fauxProvider，保证 100% 跑通真实 Pi Agent Loop
 */
export function resolvePiModelTarget(
  route?: ModelRouteSpec,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedModelTarget {
  const models = createModels()

  // 1. 显式用户配置（支持任意 OpenAI 兼容中转站 / DeepSeek / OpenAI / 通义 / GLM）
  if (route) {
    if (route.provider === 'zhizhi-faux') {
      const faux = createDeterministicFauxProvider()
      models.setProvider(faux.provider)
      return { models, model: faux.getModel(), isFaux: true }
    }

    if (route.baseUrl || (route.provider !== 'deepseek' && route.provider !== 'openai')) {
      const custom = buildCustomOpenAiCompatibleProvider(route)
      models.setProvider(custom)
      const model = models.getModel(route.provider, route.modelId)
      if (!model) {
        throw new ZhizhiError({
          code: 'LLM_PROVIDER_ERROR',
          message: `Model "${route.modelId}" not found under custom provider "${route.provider}"`,
        })
      }
      return {
        models,
        model,
        ...(route.apiKey !== undefined ? { apiKey: route.apiKey } : {}),
        isFaux: false,
      }
    }

    if (route.provider === 'deepseek') {
      models.setProvider(deepseekProvider())
    } else if (route.provider === 'openai') {
      models.setProvider(openaiProvider())
    }

    const found = models.getModel(route.provider, route.modelId)
    if (!found) {
      throw new ZhizhiError({
        code: 'LLM_PROVIDER_ERROR',
        message: `Unknown model "${route.modelId}" for provider "${route.provider}"`,
      })
    }
    return {
      models,
      model: found,
      ...(route.apiKey !== undefined ? { apiKey: route.apiKey } : {}),
      isFaux: false,
    }
  }

  // 2. 环境变量自动接入真实 DeepSeek 模型
  const deepseekKey = env['DEEPSEEK_API_KEY']?.trim()
  if (deepseekKey) {
    const baseUrl = env['DEEPSEEK_BASE_URL']?.trim()
    const modelId = env['DEEPSEEK_MODEL']?.trim() || 'deepseek-chat'
    if (baseUrl) {
      return resolvePiModelTarget({ provider: 'deepseek', modelId, baseUrl, apiKey: deepseekKey }, env)
    }
    models.setProvider(deepseekProvider())
    const dsModel = models.getModel('deepseek', modelId) ?? models.getModels('deepseek')[0]
    if (dsModel) {
      return { models, model: dsModel, apiKey: deepseekKey, isFaux: false }
    }
  }

  // 3. 无密钥本地开发 / 测试默认走 pi-ai fauxProvider（真实 Agent 循环，零 Token）
  const faux = createDeterministicFauxProvider()
  models.setProvider(faux.provider)
  return { models, model: faux.getModel(), isFaux: true }
}

/**
 * 适配 pi-agent-core 的 StreamFn，自动桥接 Models.streamSimple 与租户级 API Key。
 */
export function createPiStreamFn(target: ResolvedModelTarget) {
  return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    const mergedOptions: SimpleStreamOptions = {
      ...options,
      ...(target.apiKey !== undefined && options?.apiKey === undefined ? { apiKey: target.apiKey } : {}),
    }
    return target.models.streamSimple(model, context, mergedOptions)
  }
}
