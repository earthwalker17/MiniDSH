/**
 * The local attachment store: image bytes as content-addressed objects under
 * MiniDSH home, beside the session logs and as durable as they are.
 *
 * It writes through `node:fs` rather than `ctx.fs`, and that is the point of the
 * seam rather than a hole in it — the same trust class as `persistence-jsonl`
 * writing the log and `spill-local` writing an excerpt. The model never writes
 * here; a tool hands over bytes it has already read, and this saves the
 * harness's own record of what the model was shown.
 *
 * **The one rule.** `saveImage` returns only after the object is durable, so a
 * producer awaits the reference and only then builds the message that will be
 * appended. Nothing appends first and persists after. The accepted failure
 * direction is therefore an orphaned object when a later step fails — never a
 * log that references bytes which never existed, which no retention policy
 * could ever repair.
 *
 * **No sidecar.** The bytes on disk are opaque and extension-less; every fact
 * about them (media type, length, dimensions, display name) lives in the
 * `AttachmentRef` inside the session log. There is no index and no manifest, so
 * there is nothing that can fall out of step with the log — and a read
 * re-derives the header and compares it, so the log's metadata is checked
 * rather than trusted.
 *
 * **Admission binds intake only.** `readImage` never re-applies the limits, so
 * tightening a deployment's policy can never invalidate history a looser one
 * admitted.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import {
  ATTACHMENTS,
  AttachmentError,
  asAttachmentId,
  IMAGE_MEDIA_TYPES,
  type AttachmentRef,
  type Attachments,
  type ImageLimits,
  type SaveImage,
} from '../../core/attachments/index.ts'
import { declaredMediaType, probeImage, safeDisplayName } from './image.ts'

/**
 * Adapted DOWN from upstream's 20 MiB / 20 per message / 200 MiB / 64 MP / 8192,
 * and along a different axis. The per-REQUEST pair is the one that binds: a tool
 * that returns one image per result can never trip a per-message count, while
 * both providers tighten their own per-image limits once a request accumulates
 * images (DeepSeek at 15, Anthropic past 20 blocks, counting resent and nested
 * ones) and Anthropic caps a whole request at 32 MB. Four images at 4 MiB stays
 * far below every one of those thresholds, so the class where adding one
 * attachment retroactively invalidates a legal one cannot be reached.
 */
export const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024
/** Probed: Anthropic refuses past 8000 px on a side, naming the number. */
export const DEFAULT_MAX_IMAGE_DIMENSION = 8000
export const DEFAULT_MAX_IMAGE_PIXELS = 20_000_000
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 4
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 8 * 1024 * 1024

export interface AttachmentsLocalConfig {
  /** Store root; the versioned layout is created beneath it. */
  readonly root: string
  readonly maxImageBytes?: number | undefined
  readonly maxImageDimension?: number | undefined
  readonly maxImagePixels?: number | undefined
  readonly maxImagesPerRequest?: number | undefined
  readonly maxRequestImageBytes?: number | undefined
}

const configSchema = z.strictObject({
  root: z.string().min(1),
  maxImageBytes: z.number().int().positive().optional(),
  maxImageDimension: z.number().int().positive().optional(),
  maxImagePixels: z.number().int().positive().optional(),
  maxImagesPerRequest: z.number().int().positive().optional(),
  maxRequestImageBytes: z.number().int().positive().optional(),
})

/**
 * The layout version. It costs one path segment and buys the ability to
 * introduce a different object layout later without migrating or invalidating
 * anything: an old reference keeps resolving because its root is per-layout.
 */
const LAYOUT = 'v1'
const ID_PATTERN = /^sha256:([a-f0-9]{64})$/

function digestOf(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** One level of fan-out, so a home with many objects does not put them all in one directory. */
function objectPath(root: string, sha256: string): string {
  return join(root, LAYOUT, 'objects', sha256.slice(0, 2), sha256)
}

function digestFromId(ref: AttachmentRef): string {
  const match = ID_PATTERN.exec(ref.id)
  if (!match) throw new AttachmentError('INVALID_ATTACHMENT_REF', `"${ref.id}" is not an attachment id this store minted`)
  return match[1]!
}

/** POSIX needs the directory entry synced too; NTFS metadata journaling owns that on Windows. */
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch {
    // Best effort: a host that will not let us open a directory has already
    // given us everything it is going to.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

class LocalAttachments implements Attachments {
  readonly imageLimits: ImageLimits
  private readonly root: string

  constructor(config: AttachmentsLocalConfig) {
    this.root = config.root
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxImagesPerRequest: config.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST,
      maxRequestImageBytes: config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
      mediaTypes: IMAGE_MEDIA_TYPES,
    })
  }

  /**
   * Admission, in the order that matters: the cheap bounds precede the parse.
   * Upstream's ordering exists as a decompression-bomb defence, and while a
   * header probe is not a decode, checking a declared size before reading a
   * header is free and checking it after is not.
   */
  private admit(input: SaveImage): { data: Uint8Array; ref: Omit<AttachmentRef, 'id'>; sha256: string } {
    const { data } = input
    if (data.byteLength === 0) throw new AttachmentError('INVALID_IMAGE', 'the image is empty')
    if (data.byteLength > this.imageLimits.maxImageBytes) {
      throw new AttachmentError('IMAGE_TOO_LARGE', `the image is ${data.byteLength} bytes; this deployment accepts at most ${this.imageLimits.maxImageBytes}`)
    }
    const header = probeImage(data)
    if (!header) throw new AttachmentError('INVALID_IMAGE', 'the bytes are not a PNG, JPEG, WebP or GIF this store recognizes')
    if (!this.imageLimits.mediaTypes.includes(header.mediaType)) {
      throw new AttachmentError('UNSUPPORTED_IMAGE_TYPE', `image type ${header.mediaType} is not accepted by this deployment`)
    }
    // The DECLARED type is checked against the bytes, never trusted in place of
    // them: Anthropic refuses a request whose declaration disagrees with its
    // content, so a filename extension is not evidence.
    const declared = declaredMediaType(input.declaredMediaType)
    if (input.declaredMediaType !== undefined && declared !== header.mediaType) {
      throw new AttachmentError('IMAGE_TYPE_MISMATCH', `the image was declared ${input.declaredMediaType} but the bytes are ${header.mediaType}`)
    }
    // A floor as well as a ceiling. A corrupt or partly-written PNG can carry a
    // zero in its IHDR, and every geometry check below is an upper bound, so a
    // `0×0` ref would be committed, agree with itself on every later read, price
    // at 0 tokens, and make every subsequent request in that session fail on
    // undecodable bytes it can no longer remove from its own surface.
    if (header.width < 1 || header.height < 1) {
      throw new AttachmentError('INVALID_IMAGE', `the image header reports ${header.width}×${header.height}`)
    }
    if (header.width > this.imageLimits.maxImageDimension || header.height > this.imageLimits.maxImageDimension) {
      throw new AttachmentError('IMAGE_DIMENSION_TOO_LARGE', `the image is ${header.width}×${header.height}; this deployment accepts at most ${this.imageLimits.maxImageDimension} on a side`)
    }
    if (header.width * header.height > this.imageLimits.maxImagePixels) {
      throw new AttachmentError('IMAGE_TOO_MANY_PIXELS', `the image is ${header.width * header.height} pixels; this deployment accepts at most ${this.imageLimits.maxImagePixels}`)
    }
    const name = safeDisplayName(input.name)
    return {
      data,
      sha256: digestOf(data),
      ref: { mediaType: header.mediaType, bytes: data.byteLength, width: header.width, height: header.height, ...(name === undefined ? {} : { name }) },
    }
  }

  async saveImage(input: SaveImage): Promise<AttachmentRef> {
    const { data, ref, sha256 } = this.admit(input)
    const target = objectPath(this.root, sha256)
    const id = asAttachmentId(`sha256:${sha256}`)
    try {
      // Content addressing makes a repeat save idempotent: the object already
      // there IS these bytes, so there is nothing to write and nothing to check.
      if (statSync(target, { throwIfNoEntry: false })?.isFile() === true) return Object.freeze({ id, ...ref })
      this.publish(target, data, sha256)
    } catch (error) {
      if (error instanceof AttachmentError) throw error
      throw new AttachmentError('ATTACHMENT_WRITE_FAILED', `could not store the attachment: ${error instanceof Error ? error.message : String(error)}`)
    }
    return Object.freeze({ id, ...ref })
  }

  /**
   * Durable before the reference exists: write to a staging name, flush the file
   * itself, move it into place atomically, then flush the directory entry. A
   * synced file whose directory entry never reached storage is not durable, and
   * a rename that lands before the content does would leave a valid-looking
   * object full of nothing.
   */
  private publish(target: string, data: Uint8Array, sha256: string): void {
    const staging = join(this.root, LAYOUT, 'tmp')
    const bucket = join(this.root, LAYOUT, 'objects', sha256.slice(0, 2))
    // 0700 on POSIX; Windows inherits the home's ACL, which is the user's own.
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    mkdirSync(bucket, { recursive: true, mode: 0o700 })
    // Unique per CALL. Keyed by digest and pid alone, two concurrent saves of
    // the SAME image inside one process — which `minidsh serve` reaches whenever
    // two sessions view one file at once — share the staging name: the second
    // open truncates the first's in-progress write, and then the renames race,
    // so one caller gets a storage fault for an image that is perfectly valid
    // and about to be correctly stored.
    const temporary = join(staging, `${sha256}.${process.pid}.${randomUUID()}.part`)
    let fd: number | undefined
    try {
      fd = openSync(temporary, 'w', 0o600)
      const written = writeSync(fd, data, 0, data.byteLength)
      if (written !== data.byteLength) throw new Error(`wrote ${written} of ${data.byteLength} bytes`)
      fsyncSync(fd)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    try {
      renameSync(temporary, target)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // The staging file is this store's own litter; a failure to clear it is not the caller's problem.
      }
      throw error
    }
    syncDirectory(bucket)
  }

  async readImage(ref: AttachmentRef): Promise<Uint8Array> {
    const sha256 = digestFromId(ref)
    let data: Uint8Array
    try {
      data = readFileSync(objectPath(this.root, sha256))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new AttachmentError('ATTACHMENT_NOT_FOUND', `attachment ${ref.id} is missing from this store`)
      throw new AttachmentError('ATTACHMENT_READ_FAILED', `could not read attachment ${ref.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Identity first, then the metadata the LOG carries. Admission limits are
    // deliberately not re-applied: they bound what may be stored, never what may
    // be read back.
    if (digestOf(data) !== sha256) throw new AttachmentError('ATTACHMENT_CORRUPT', `attachment ${ref.id} failed integrity verification`)
    const header = probeImage(data)
    if (!header || header.mediaType !== ref.mediaType || header.width !== ref.width || header.height !== ref.height || data.byteLength !== ref.bytes) {
      throw new AttachmentError('ATTACHMENT_CORRUPT', `attachment ${ref.id} does not match the reference the log records`)
    }
    return data
  }

  hostPath(ref: AttachmentRef): string | undefined {
    // `undefined`, never a throw: the contract is "where this host keeps it, if
    // it keeps one", and a ref minted by another store or another layout is
    // simply not one this store has. Throwing here would abort `sessions show`
    // mid-transcript on the one log a reader most needs explained. `readImage`
    // keeps its throw, because there the caller needs the code.
    const match = ID_PATTERN.exec(ref.id)
    return match ? objectPath(this.root, match[1]!) : undefined
  }
}

/**
 * Provides `ctx.attachments`. A service row with no model-facing surface, so it
 * ships by default while the tools that produce images stay composition — the
 * plane exists wherever MiniDSH runs, and the shipped tool set does not grow.
 */
export const attachmentsLocalPlugin: Plugin<AttachmentsLocalConfig> = {
  name: 'attachments-local',
  config: configSchema,
  apply(ctx, config) {
    ctx.provide(ATTACHMENTS, new LocalAttachments(config))
  },
}
