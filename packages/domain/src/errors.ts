/**
 * 统一错误码。
 * 规则：任何对外失败都必须落到这里的某个码，禁止抛裸 Error、禁止把 500 直接暴露给用户。
 */
export const EC = {
  AUTH_REQUIRED: 'EAB_AUTH_REQUIRED',
  FORBIDDEN: 'EAB_FORBIDDEN',
  SCOPE_DENIED: 'EAB_SCOPE_DENIED',
  APPROVAL_REQUIRED: 'EAB_APPROVAL_REQUIRED',
  NOT_FOUND: 'EAB_NOT_FOUND',
  CONFLICT: 'EAB_CONFLICT',
  VALIDATION: 'EAB_VALIDATION',
  QUOTA_EXCEEDED: 'EAB_QUOTA_EXCEEDED',
  RATE_LIMITED: 'EAB_RATE_LIMITED',
  UPSTREAM: 'EAB_UPSTREAM',
  INTERNAL: 'EAB_INTERNAL',
} as const

export type ErrorCode = (typeof EC)[keyof typeof EC]

export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  [EC.AUTH_REQUIRED]: 401,
  [EC.FORBIDDEN]: 403,
  [EC.SCOPE_DENIED]: 403,
  [EC.APPROVAL_REQUIRED]: 202,
  [EC.NOT_FOUND]: 404,
  [EC.CONFLICT]: 409,
  [EC.VALIDATION]: 400,
  [EC.QUOTA_EXCEEDED]: 429,
  [EC.RATE_LIMITED]: 429,
  [EC.UPSTREAM]: 502,
  [EC.INTERNAL]: 500,
}

export interface EabErrorOptions {
  /** 结构化上下文，进日志与响应（禁止放密钥/完整文件内容） */
  details?: unknown
  /** 给用户的下一步建议（人话，可行动） */
  hint?: string
  cause?: unknown
}

export interface ErrorEnvelope {
  ok: false
  code: ErrorCode
  message: string
  details?: unknown
  hint?: string
  traceId?: string
}

export class EabError extends Error {
  readonly code: ErrorCode
  readonly details?: unknown
  readonly hint?: string

  constructor(code: ErrorCode, message: string, options: EabErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'EabError'
    this.code = code
    this.details = options.details
    this.hint = options.hint
  }

  get httpStatus(): number {
    return HTTP_STATUS_BY_CODE[this.code]
  }

  toEnvelope(traceId?: string): ErrorEnvelope {
    const base: ErrorEnvelope = { ok: false, code: this.code, message: this.message }
    if (this.details !== undefined) base.details = this.details
    if (this.hint !== undefined) base.hint = this.hint
    if (traceId !== undefined) base.traceId = traceId
    return base
  }

  static scopeDenied(message: string, hint: string, details?: unknown): EabError {
    return new EabError(EC.SCOPE_DENIED, message, { hint, details })
  }

  static forbidden(message: string, hint?: string): EabError {
    return new EabError(EC.FORBIDDEN, message, { hint })
  }
}

/** 归一化任意异常为 EabError（对外层用，保证不泄漏内部细节） */
export function toEabError(err: unknown): EabError {
  if (err instanceof EabError) return err
  if (err instanceof Error) {
    return new EabError(EC.INTERNAL, '系统异常，请稍后重试', { cause: err })
  }
  return new EabError(EC.INTERNAL, '系统异常，请稍后重试')
}
