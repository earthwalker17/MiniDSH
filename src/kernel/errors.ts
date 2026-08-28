export type KernelErrorCode =
  | 'SERVICE_NOT_INJECTED'
  | 'SERVICE_UNAVAILABLE'
  | 'SERVICE_DUPLICATE'
  | 'INACTIVE_OWNER'
  | 'PLUGIN_FAILED'
  | 'DISPATCH_REJECTED'
  | 'DISPATCH_REENTERED'
  | 'SCOPE_NESTED'
  | 'PLUGIN_CONFIG'
  | 'SCOPED_OWNER'

/** Every kernel failure carries a stable code; message text is for humans. */
export class KernelError extends Error {
  readonly code: KernelErrorCode
  constructor(code: KernelErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'KernelError'
    this.code = code
  }
}
