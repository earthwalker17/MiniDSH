/**
 * The binary plane: bytes the model saw that must not enter the log.
 *
 * One rule carries the whole design, and it is upstream's sentence verbatim:
 * **validate and durably commit one image before its owning session event is
 * appended**. A producer awaits the reference, then builds the message. There
 * is no append-then-persist path and no post-hoc fixup, so the accepted failure
 * direction is an orphaned object on a later failure — never a log that
 * references bytes which never existed.
 *
 * What lands in the log is an `AttachmentRef`: an opaque id, the media type
 * VERIFIED from the bytes, the exact byte length and the intrinsic dimensions.
 * No base64, no host path, no provider URL. A surface can lay out history
 * without decoding anything, and `session.events` stays JSON-lossless.
 *
 * **Dependency direction, decided before a line was written.** This module
 * imports nothing from `core/llm`; `core/llm` imports the reference as a TYPE.
 * `AttachmentError` therefore does not extend `LlmError` — consumers route on
 * `code`, never on the prototype chain. Upstream reaches the same place for the
 * same reason: the two vocabularies would otherwise form a cycle, and
 * `scripts/check-deps.ts` permits the arrow without being able to see the cycle.
 */
import { serviceKey } from '../../kernel/index.ts'
import type { Brand } from '../ids.ts'

/**
 * Opaque storage identity — never a filesystem path and never a bearer URL. The
 * local store spells it `sha256:<64 hex>`, but a consumer must neither parse
 * that nor derive a path from it: `Attachments.hostPath` is the sanctioned way
 * to reach the object, and it is the provider's answer, not the id's.
 */
export type AttachmentId = Brand<string, 'AttachmentId'>
export const asAttachmentId = (value: string): AttachmentId => value as AttachmentId

/**
 * The raster formats this plane accepts, closed at four. It is exactly the set
 * Anthropic's API enumerates in its own refusal ("Input should be 'image/jpeg',
 * 'image/png', 'image/gif' or 'image/webp'"), and DSH's own closed union.
 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

export function isImageMediaType(value: string): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value)
}

/**
 * What the log records about one image. Every field earns its place: `bytes`,
 * `width` and `height` let a surface render history without reading the object,
 * and `mediaType` is what the bytes actually are — Anthropic refuses a request
 * whose declared type disagrees with its content, so a filename extension is
 * not evidence.
 */
export interface AttachmentRef {
  readonly id: AttachmentId
  readonly mediaType: ImageMediaType
  /** Exact encoded length of the stored object. */
  readonly bytes: number
  readonly width: number
  readonly height: number
  /** A display leaf, sanitized of any path information; absent when there was none worth keeping. */
  readonly name?: string
}

/**
 * Admission policy, readable synchronously so a producer can refuse before it
 * reads a byte. These bind INTAKE only: `readImage` never re-applies them, so
 * tightening the policy can never invalidate history a looser policy admitted.
 */
export interface ImageLimits {
  readonly maxImageBytes: number
  readonly maxImageDimension: number
  readonly maxImagePixels: number
  /** Images one REQUEST may carry, folded over the live surface — the limit that actually binds (§ below). */
  readonly maxImagesPerRequest: number
  readonly maxRequestImageBytes: number
  readonly mediaTypes: readonly ImageMediaType[]
}

export interface SaveImage {
  readonly data: Uint8Array
  /** What the caller believes it is; refused when the bytes disagree. Omitted lets the sniffer decide. */
  readonly declaredMediaType?: string
  /** A file name or label; sanitized to a leaf before it can reach the log. */
  readonly name?: string
}

/**
 * Two classes, and the split is what lets one boundary decide between "tell the
 * model to try something smaller" and "fail the turn". Caller-correctable codes
 * describe the input; storage codes describe this host.
 */
export type AttachmentErrorCode =
  // caller-correctable
  | 'UNSUPPORTED_IMAGE_TYPE'
  | 'IMAGE_TYPE_MISMATCH'
  | 'INVALID_IMAGE'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_DIMENSION_TOO_LARGE'
  | 'IMAGE_TOO_MANY_PIXELS'
  | 'TOO_MANY_IMAGES'
  // storage
  | 'INVALID_ATTACHMENT_REF'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_CORRUPT'
  | 'ATTACHMENT_WRITE_FAILED'
  | 'ATTACHMENT_READ_FAILED'

const ADMISSION_CODES: ReadonlySet<string> = new Set([
  'UNSUPPORTED_IMAGE_TYPE',
  'IMAGE_TYPE_MISMATCH',
  'INVALID_IMAGE',
  'IMAGE_TOO_LARGE',
  'IMAGE_DIMENSION_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
  'TOO_MANY_IMAGES',
])

/** Deliberately not an `LlmError` subclass: see the module note on the dependency cycle. */
export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode
  constructor(code: AttachmentErrorCode, message: string) {
    super(message)
    this.name = 'AttachmentError'
    this.code = code
  }
}

/** Structural, never `instanceof`: the check must survive an error crossing a module boundary. */
export function isImageAdmissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && ADMISSION_CODES.has(error.code)
}

export interface Attachments {
  /** Policy a producer reads BEFORE any filesystem work, so a refusal costs nothing. */
  readonly imageLimits: ImageLimits
  /** Validate and durably commit one image before its owning session event is appended. */
  saveImage(input: SaveImage): Promise<AttachmentRef>
  /** Read one image back, re-verifying that the bytes still match every field of the reference. */
  readImage(ref: AttachmentRef): Promise<Uint8Array>
  /** Where the provider keeps the object, when it keeps one on this host. Says nothing about who may read it. */
  hostPath(ref: AttachmentRef): string | undefined
}

export const ATTACHMENTS = serviceKey<Attachments>('attachments')
