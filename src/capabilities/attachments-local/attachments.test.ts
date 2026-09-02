/**
 * The local attachment store, against a real directory.
 *
 * The assertion that actually binds is `sha256(source bytes) === ref.id`.
 * Hashing the stored object and comparing it to its own id would only prove the
 * store agrees with its own naming rule — it would pass on a truncated write or
 * on the wrong file entirely.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Logger } from '../../kernel/index.ts'
import { ATTACHMENTS, AttachmentError, asAttachmentId, isImageAdmissionError, type AttachmentRef, type Attachments } from '../../core/attachments/index.ts'
import { attachmentsLocalPlugin } from './index.ts'
import { probeImage, safeDisplayName } from './image.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

async function store(config: Record<string, unknown> = {}): Promise<{ attachments: Attachments; root: string; dispose: () => Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), 'minidsh-attach-'))
  roots.push(root)
  const ctx = createRoot({ logger: silent })
  ctx.plugin(attachmentsLocalPlugin, { root, ...config })
  await ctx.settle()
  return { attachments: ctx.get(ATTACHMENTS), root, dispose: () => ctx.dispose() }
}

// ---- image builders, so the tests own their own bytes ----------------------

const crcTable = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c
}
function crc32(buffer: Buffer): number {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
/** A PNG of `width`×`height` split into four coloured quadrants. */
export function quadPng(width: number, height = width): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3))
  const colours = [
    [255, 0, 0],
    [0, 160, 0],
    [0, 0, 255],
    [255, 255, 255],
  ]
  let at = 0
  for (let y = 0; y < height; y++) {
    raw[at++] = 0
    for (let x = 0; x < width; x++) {
      const colour = colours[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]!
      raw[at++] = colour[0]!
      raw[at++] = colour[1]!
      raw[at++] = colour[2]!
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

describe('probeImage', () => {
  it('reads dimensions from the header of each accepted type', () => {
    expect(probeImage(quadPng(96))).toEqual({ mediaType: 'image/png', width: 96, height: 96 })
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([12, 0, 34, 0]), Buffer.alloc(4)])
    expect(probeImage(gif)).toEqual({ mediaType: 'image/gif', width: 12, height: 34 })
    const sof = Buffer.concat([Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), Buffer.from([0, 56, 0, 78]), Buffer.alloc(8)])
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'ascii'), Buffer.alloc(11), sof, Buffer.from([0xff, 0xd9])])
    expect(probeImage(jpeg)).toEqual({ mediaType: 'image/jpeg', width: 78, height: 56 })
    const vp8x = Buffer.alloc(10)
    vp8x[0] = 0x08
    vp8x.writeUIntLE(99, 4, 3)
    vp8x.writeUIntLE(199, 7, 3)
    const inner = Buffer.concat([Buffer.from('WEBP', 'ascii'), Buffer.from('VP8X', 'ascii'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(10); return b })(), vp8x])
    const size = Buffer.alloc(4)
    size.writeUInt32LE(inner.length)
    expect(probeImage(Buffer.concat([Buffer.from('RIFF', 'ascii'), size, inner]))).toEqual({ mediaType: 'image/webp', width: 100, height: 200 })
  })

  it('refuses bytes that are none of the four', () => {
    expect(probeImage(Buffer.from('not an image at all, really'))).toBeUndefined()
  })

  /**
   * The stated cost of not decoding. A truncated file passes admission here and
   * is refused by the provider, which is a reported error rather than anything
   * the log has to carry.
   */
  it('accepts a truncated file whose header survived — the header-only weakness, measured', () => {
    expect(probeImage(quadPng(96).subarray(0, 40))).toEqual({ mediaType: 'image/png', width: 96, height: 96 })
  })
})

describe('safeDisplayName', () => {
  it('keeps a leaf and nothing that could be a path', () => {
    // `path.basename` would keep the whole thing on a POSIX host, because a
    // backslash is an ordinary character there.
    expect(safeDisplayName('C:\\Users\\someone\\secret\\quad.png')).toBe('quad.png')
    expect(safeDisplayName('/home/someone/quad.png')).toBe('quad.png')
  })

  it('strips control characters, which a terminal would otherwise render', () => {
    expect(safeDisplayName('qu\u001bad\u007f.png')).toBe('quad.png')
    expect(safeDisplayName('   ')).toBeUndefined()
    expect(safeDisplayName(undefined)).toBeUndefined()
  })
})

describe('saveImage', () => {
  it('addresses the SOURCE bytes, and puts exactly those bytes on disk', async () => {
    const { attachments, root, dispose } = await store()
    const png = quadPng(96)
    const ref = await attachments.saveImage({ data: png, name: 'quad.png' })
    expect(ref.id).toBe(`sha256:${sha256(png)}`)
    expect(ref).toMatchObject({ mediaType: 'image/png', bytes: png.length, width: 96, height: 96, name: 'quad.png' })
    const path = attachments.hostPath(ref)!
    expect(path).toContain(join('v1', 'objects', sha256(png).slice(0, 2)))
    expect(readFileSync(path).equals(png)).toBe(true)
    expect(root).toBeTruthy()
    await dispose()
  })

  it('is idempotent: the same bytes save to one object and one id', async () => {
    const { attachments, dispose } = await store()
    const png = quadPng(64)
    const first = await attachments.saveImage({ data: png, name: 'a.png' })
    const second = await attachments.saveImage({ data: png, name: 'b.png' })
    expect(second.id).toBe(first.id)
    // Identity addresses the bytes; the display name rides along and may differ.
    expect(second.name).toBe('b.png')
    await dispose()
  })

  it('checks the DECLARED media type against the bytes, because Anthropic does', async () => {
    const { attachments, dispose } = await store()
    await expect(attachments.saveImage({ data: quadPng(32), declaredMediaType: 'image/jpeg' })).rejects.toMatchObject({ code: 'IMAGE_TYPE_MISMATCH' })
    await expect(attachments.saveImage({ data: quadPng(32), declaredMediaType: 'image/png' })).resolves.toBeDefined()
    await dispose()
  })

  it('refuses what it cannot recognize, and says which kind of refusal it is', async () => {
    const { attachments, dispose } = await store({ maxImageBytes: 4096, maxImageDimension: 64 })
    const cases: [Uint8Array, string][] = [
      [new Uint8Array(0), 'INVALID_IMAGE'],
      [Buffer.from('plain text, not an image'), 'INVALID_IMAGE'],
      [quadPng(96), 'IMAGE_DIMENSION_TOO_LARGE'],
    ]
    for (const [data, code] of cases) {
      const error = await attachments.saveImage({ data }).then(() => undefined, (e: unknown) => e)
      expect((error as AttachmentError).code, `for ${code}`).toBe(code)
      // Every one of these is the caller's to fix, not this host's to report.
      expect(isImageAdmissionError(error)).toBe(true)
    }
    await dispose()
  })

  it('refuses a file over the byte cap before it looks at the header', async () => {
    const { attachments, dispose } = await store({ maxImageBytes: 100 })
    await expect(attachments.saveImage({ data: quadPng(96) })).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    await dispose()
  })

  it('refuses too many pixels even inside the per-side cap', async () => {
    const { attachments, dispose } = await store({ maxImagePixels: 1000 })
    await expect(attachments.saveImage({ data: quadPng(96) })).rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
    await dispose()
  })
})

describe('readImage', () => {
  it('returns the bytes it stored', async () => {
    const { attachments, dispose } = await store()
    const png = quadPng(48)
    const ref = await attachments.saveImage({ data: png })
    expect(Buffer.from(await attachments.readImage(ref)).equals(png)).toBe(true)
    await dispose()
  })

  it('reports a missing object rather than an empty one', async () => {
    const { attachments, dispose } = await store()
    const absent: AttachmentRef = { id: asAttachmentId(`sha256:${'0'.repeat(64)}`), mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
    await expect(attachments.readImage(absent)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    expect(isImageAdmissionError(await attachments.readImage(absent).catch((e: unknown) => e))).toBe(false)
    await dispose()
  })

  it('refuses an object whose bytes no longer match its id', async () => {
    const { attachments, dispose } = await store()
    const ref = await attachments.saveImage({ data: quadPng(48) })
    writeFileSync(attachments.hostPath(ref)!, quadPng(64))
    await expect(attachments.readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    await dispose()
  })

  it('refuses an id this store never minted', async () => {
    const { attachments, dispose } = await store()
    const forged: AttachmentRef = { id: asAttachmentId('../../etc/passwd'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
    await expect(attachments.readImage(forged)).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })
    expect(() => attachments.hostPath(forged)).toThrowError(AttachmentError)
    await dispose()
  })

  /**
   * Admission limits bind INTAKE. Re-applying them on read would mean that
   * tightening a deployment's policy retroactively broke every session whose
   * history a looser policy had already admitted.
   */
  it('does not re-apply admission limits, so tightening policy cannot invalidate history', async () => {
    const permissive = await store()
    const png = quadPng(96)
    const ref = await permissive.attachments.saveImage({ data: png })
    const strict = await store({ maxImageDimension: 16, maxImageBytes: 32 })
    // The two stores have separate roots, so place the same object under the
    // strict one by hand — this is a read of history a looser policy admitted.
    const target = strict.attachments.hostPath(ref)!
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, png)
    await expect(strict.attachments.readImage(ref)).resolves.toBeDefined()
    await expect(strict.attachments.saveImage({ data: png })).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
    await permissive.dispose()
    await strict.dispose()
  })
})
