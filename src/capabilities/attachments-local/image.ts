/**
 * What an image is, read from its own header.
 *
 * MiniDSH does not decode rasters and takes no image dependency. Upstream does
 * (Sharp/libvips), and pays for it twice: a native binding, and an identity that
 * is encoder-build dependent — its own README records that an encoder upgrade
 * re-addresses future objects, so the same source file yields different ids on
 * different machines. Because nothing here is re-encoded, an id addresses
 * exactly the bytes the user gave, and the same file has the same id everywhere.
 *
 * The cost is stated rather than hidden: this is a signature-and-header check,
 * so a well-headed but TRUNCATED file is admitted here and refused by the
 * provider (measured: the first 40 bytes of a 96x96 PNG still probe as
 * 96x96). That is a reported provider error, never a corrupted log.
 *
 * The four types are exactly what both providers accept — Anthropic enumerates
 * them in its own refusal, and it VERIFIES the declared type against the bytes,
 * which is why a filename extension is never evidence here.
 */
import { isImageMediaType, type ImageMediaType } from '../../core/attachments/index.ts'

export interface ImageHeader {
  readonly mediaType: ImageMediaType
  readonly width: number
  readonly height: number
}

const PNG_SIGNATURE = 0x89504e47

/** The header's own account of itself, or `undefined` when the bytes are not one of the four. */
export function probeImage(data: Uint8Array): ImageHeader | undefined {
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return probePng(view) ?? probeGif(view) ?? probeWebp(view) ?? probeJpeg(view)
}

function probePng(d: Buffer): ImageHeader | undefined {
  if (d.length < 24 || d.readUInt32BE(0) !== PNG_SIGNATURE || d.toString('ascii', 12, 16) !== 'IHDR') return undefined
  return { mediaType: 'image/png', width: d.readUInt32BE(16), height: d.readUInt32BE(20) }
}

function probeGif(d: Buffer): ImageHeader | undefined {
  if (d.length < 10 || d.toString('ascii', 0, 3) !== 'GIF') return undefined
  // The logical screen descriptor, little-endian, straight after the 6-byte version.
  return { mediaType: 'image/gif', width: d.readUInt16LE(6), height: d.readUInt16LE(8) }
}

function probeWebp(d: Buffer): ImageHeader | undefined {
  if (d.length < 30 || d.toString('ascii', 0, 4) !== 'RIFF' || d.toString('ascii', 8, 12) !== 'WEBP') return undefined
  const fourcc = d.toString('ascii', 12, 16)
  // Three container shapes, and each states its size differently.
  if (fourcc === 'VP8X') {
    return { mediaType: 'image/webp', width: (d[24]! | (d[25]! << 8) | (d[26]! << 16)) + 1, height: (d[27]! | (d[28]! << 8) | (d[29]! << 16)) + 1 }
  }
  if (fourcc === 'VP8 ') {
    return { mediaType: 'image/webp', width: d.readUInt16LE(26) & 0x3fff, height: d.readUInt16LE(28) & 0x3fff }
  }
  if (fourcc === 'VP8L') {
    const packed = d.readUInt32LE(21)
    return { mediaType: 'image/webp', width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 }
  }
  return undefined
}

/** JPEG has no fixed header: walk the marker segments to the start-of-frame that carries the size. */
function probeJpeg(d: Buffer): ImageHeader | undefined {
  if (d.length < 4 || d[0] !== 0xff || d[1] !== 0xd8) return undefined
  let at = 2
  while (at + 9 < d.length) {
    if (d[at] !== 0xff) {
      at += 1
      continue
    }
    const marker = d[at + 1]!
    // Standalone markers carry no length: SOI, TEM and the restart markers.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    // Any start-of-frame except DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mediaType: 'image/jpeg', height: d.readUInt16BE(at + 5), width: d.readUInt16BE(at + 7) }
    }
    at += 2 + d.readUInt16BE(at + 2)
  }
  return undefined
}

/**
 * A display leaf, safe to keep in the log forever.
 *
 * Both separators are stripped by hand rather than with `path.basename`: a POSIX
 * host treats a backslash as an ordinary character, so `basename` would keep a
 * Windows client's whole local path and make it permanent log content. Control
 * characters go too, DEL included — this string is rendered in a terminal.
 */
export function safeDisplayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = [...leaf].filter((ch) => { const code = ch.codePointAt(0)!; return code > 0x1f && code !== 0x7f }).join('').trim().slice(0, 255)
  return clean.length === 0 ? undefined : clean
}

/** The declared type when there is one and it is one of the four; otherwise nothing to check against. */
export function declaredMediaType(value: string | undefined): ImageMediaType | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  return isImageMediaType(normalized) ? normalized : undefined
}
