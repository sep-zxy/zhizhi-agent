export type ZhizhiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'TENANT_ISOLATION_VIOLATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PLUGIN_UNAVAILABLE'
  | 'SCHEMA_INVALID'
  | 'SLOT_PINNED'
  | 'TOOL_DISABLED'
  | 'LLM_PROVIDER_ERROR'
  | 'JOB_FAILED'
  | 'INTERNAL_ERROR'

export interface ZhizhiErrorOptions {
  code: ZhizhiErrorCode
  message: string
  httpStatus?: number
  retryable?: boolean
  details?: Record<string, unknown>
  cause?: unknown
}

const DEFAULT_HTTP_STATUS: Record<ZhizhiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  TENANT_ISOLATION_VIOLATION: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PLUGIN_UNAVAILABLE: 503,
  SCHEMA_INVALID: 422,
  SLOT_PINNED: 409,
  TOOL_DISABLED: 403,
  LLM_PROVIDER_ERROR: 502,
  JOB_FAILED: 500,
  INTERNAL_ERROR: 500,
}

/**
 * 全仓统一结构化错误（对标 DeepSeek Harness 的 HarnessError）。
 */
export class ZhizhiError extends Error {
  readonly code: ZhizhiErrorCode
  readonly httpStatus: number
  readonly retryable: boolean
  readonly details: Record<string, unknown> | undefined

  constructor(options: ZhizhiErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ZhizhiError'
    this.code = options.code
    this.httpStatus = options.httpStatus ?? DEFAULT_HTTP_STATUS[options.code]
    this.retryable = options.retryable ?? false
    this.details = options.details
  }

  toJSON(): {
    code: ZhizhiErrorCode
    message: string
    retryable: boolean
    details?: Record<string, unknown>
  } {
    return this.details !== undefined
      ? { code: this.code, message: this.message, retryable: this.retryable, details: this.details }
      : { code: this.code, message: this.message, retryable: this.retryable }
  }
}

export function isZhizhiError(value: unknown): value is ZhizhiError {
  return value instanceof ZhizhiError
}
