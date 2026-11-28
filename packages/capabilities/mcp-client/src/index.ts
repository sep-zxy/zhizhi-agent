import { z } from 'zod'
import { ZhizhiError } from '@zhizhi/errors'

export interface McpClientConfig {
  readonly endpointUrl: string
  readonly apiKey?: string
  readonly authHeaderName?: 'Authorization' | 'X-API-Key'
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

export interface McpToolCallResult {
  readonly isError: boolean
  readonly text: string
  readonly json: unknown
}

export interface McpPingResult {
  readonly ok: boolean
  readonly latencyMs: number
  readonly detail?: string
}

type RpcResult = unknown

/**
 * 公共能力缝隙：受控 MCP 客户端（不暴露给 Pi Agent 主循环，仅由服务端插件与管线调用）。
 */
export interface McpClientHandle {
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult>
  listTools(signal?: AbortSignal): Promise<string[]>
  ping(signal?: AbortSignal): Promise<McpPingResult>
}

const JsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
})

const JsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.string().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: JsonRpcErrorSchema.optional(),
})

const McpContentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
})

const McpCallToolResponseSchema = z.object({
  content: z.array(McpContentBlockSchema).default([]),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
})

const McpListToolsResponseSchema = z.object({
  tools: z.array(z.object({ name: z.string() })).default([]),
})

/**
 * 解析 Streamable HTTP MCP 响应体：兼容纯 JSON 与 `text/event-stream` SSE 帧。
 */
export function parseStreamableMcpBody(rawText: string, contentType: string): unknown {
  const trimmed = rawText.trim()
  if (trimmed.length === 0) {
    throw new ZhizhiError({
      code: 'PLUGIN_UNAVAILABLE',
      message: 'MCP server returned an empty response body',
      retryable: true,
    })
  }

  const looksLikeSse =
    contentType.includes('text/event-stream')
    || trimmed.startsWith('event:')
    || trimmed.startsWith('data:')

  if (!looksLikeSse) {
    try {
      return JSON.parse(trimmed)
    } catch (err) {
      throw new ZhizhiError({
        code: 'SCHEMA_INVALID',
        message: 'Failed to parse JSON body from MCP server',
        cause: err,
      })
    }
  }

  const dataPayloads: string[] = []
  let currentDataLines: string[] = []

  for (const line of rawText.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      currentDataLines.push(line.slice(5).trimStart())
    } else if (line.trim() === '') {
      if (currentDataLines.length > 0) {
        dataPayloads.push(currentDataLines.join('\n'))
        currentDataLines = []
      }
    }
  }
  if (currentDataLines.length > 0) {
    dataPayloads.push(currentDataLines.join('\n'))
  }

  for (let i = dataPayloads.length - 1; i >= 0; i -= 1) {
    const candidate = dataPayloads[i]?.trim()
    if (!candidate || candidate === '[DONE]') continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && ('result' in parsed || 'error' in parsed)) {
        return parsed
      }
    } catch (_err) {
      // Ignore intermediate non-JSON progress lines and continue scanning frames.
    }
  }

  const lastPayload = dataPayloads[dataPayloads.length - 1]
  if (!lastPayload) {
    throw new ZhizhiError({
      code: 'SCHEMA_INVALID',
      message: 'MCP SSE response contained no JSON-RPC data frame',
    })
  }
  try {
    return JSON.parse(lastPayload)
  } catch (err) {
    throw new ZhizhiError({
      code: 'SCHEMA_INVALID',
      message: 'Failed to parse final MCP SSE data frame as JSON',
      cause: err,
    })
  }
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined
  }
  try {
    return JSON.parse(trimmed)
  } catch (_err) {
    return undefined
  }
}

function combineSignals(timeoutMs: number, external?: AbortSignal): {
  readonly signal: AbortSignal
  readonly cleanup: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`MCP request timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  const onExternalAbort = (): void => {
    controller.abort(external?.reason ?? new Error('MCP request aborted by caller'))
  }

  if (external) {
    if (external.aborted) {
      onExternalAbort()
    } else {
      external.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      if (external) {
        external.removeEventListener('abort', onExternalAbort)
      }
    },
  }
}

/**
 * 无状态 Streamable HTTP MCP 客户端（原生兼容 DTK v5 `/mcp/` 及标准 MCP Streamable HTTP 服务）。
 */
export class StreamableHttpMcpClient implements McpClientHandle {
  private readonly endpointUrl: string
  private readonly apiKey: string | undefined
  private readonly authHeaderName: 'Authorization' | 'X-API-Key'
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private nextRequestId = 1

  constructor(config: McpClientConfig) {
    if (!config.endpointUrl.trim()) {
      throw new ZhizhiError({
        code: 'VALIDATION_FAILED',
        message: 'MCP endpointUrl must be non-empty',
      })
    }
    this.endpointUrl = config.endpointUrl
    this.apiKey = config.apiKey
    this.authHeaderName = config.authHeaderName ?? 'Authorization'
    this.timeoutMs = config.timeoutMs ?? 65_000
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    const rawResult = await this.rpc('tools/call', { name, arguments: args }, signal)
    const parsed = McpCallToolResponseSchema.safeParse(rawResult)
    if (!parsed.success) {
      throw new ZhizhiError({
        code: 'SCHEMA_INVALID',
        message: `MCP tool "${name}" returned unexpected payload shape`,
        details: { issues: parsed.error.issues },
      })
    }

    const text = parsed.data.content
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text ?? '')
      .join('\n')
      .trim()

    const json = parsed.data.structuredContent !== undefined
      ? parsed.data.structuredContent
      : tryParseJson(text)

    return {
      isError: parsed.data.isError === true,
      text,
      json,
    }
  }

  async listTools(signal?: AbortSignal): Promise<string[]> {
    const rawResult = await this.rpc('tools/list', {}, signal)
    const parsed = McpListToolsResponseSchema.safeParse(rawResult)
    if (!parsed.success) {
      throw new ZhizhiError({
        code: 'SCHEMA_INVALID',
        message: 'MCP tools/list returned unexpected payload shape',
        details: { issues: parsed.error.issues },
      })
    }
    return parsed.data.tools.map(tool => tool.name)
  }

  async ping(signal?: AbortSignal): Promise<McpPingResult> {
    const start = Date.now()
    try {
      const tools = await this.listTools(signal)
      return {
        ok: true,
        latencyMs: Date.now() - start,
        detail: `Connected (${tools.length} tools available)`,
      }
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        detail: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    externalSignal?: AbortSignal,
  ): Promise<RpcResult> {
    const id = this.nextRequestId
    this.nextRequestId += 1

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (this.apiKey && this.apiKey.trim().length > 0) {
      headers[this.authHeaderName] =
        this.authHeaderName === 'Authorization' ? `Bearer ${this.apiKey}` : this.apiKey
    }

    const { signal, cleanup } = combineSignals(this.timeoutMs, externalSignal)
    let response: Response
    try {
      response = await this.fetchImpl(this.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal,
      })
    } catch (err) {
      throw new ZhizhiError({
        code: 'PLUGIN_UNAVAILABLE',
        message: `Failed to reach MCP server at ${this.endpointUrl}: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        cause: err,
      })
    } finally {
      cleanup()
    }

    const contentType = response.headers.get('content-type') ?? ''
    const bodyText = await response.text()

    if (!response.ok) {
      throw new ZhizhiError({
        code: response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : 'PLUGIN_UNAVAILABLE',
        message: `MCP server responded with HTTP ${response.status}`,
        retryable: response.status >= 500 || response.status === 429,
        details: { status: response.status, preview: bodyText.slice(0, 300) },
      })
    }

    const parsedBody = parseStreamableMcpBody(bodyText, contentType)
    const envelope = JsonRpcEnvelopeSchema.safeParse(parsedBody)
    if (!envelope.success) {
      throw new ZhizhiError({
        code: 'SCHEMA_INVALID',
        message: 'MCP response is not a valid JSON-RPC envelope',
        details: { issues: envelope.error.issues },
      })
    }

    if (envelope.data.error) {
      throw new ZhizhiError({
        code: 'PLUGIN_UNAVAILABLE',
        message: `MCP JSON-RPC error (${envelope.data.error.code}): ${envelope.data.error.message}`,
        retryable: envelope.data.error.code < -32000,
      })
    }

    return envelope.data.result
  }
}
