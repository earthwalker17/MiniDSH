/**
 * Deterministic image bytes for tests and live arcs.
 *
 * A test that needs an image builds it here rather than committing a binary
 * fixture, so an assertion can compare against the pixels it drew — and so a
 * live arc's expected answer is a fact the test knows rather than one the model
 * is trusted to report.
 *
 * PNG only, and by hand: MiniDSH takes no image dependency, and a 40-line
 * encoder is cheaper than one.
 */
import { deflateSync } from 'node:zlib'

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

/**
 * The four quadrant colours in draw order — top-left, top-right, bottom-left,
 * bottom-right — as the model should name them.
 *
 * Deliberately NOT red/green/blue/white. That is the canonical RGB triple in
 * the canonical raster order, and it is the most probable guess for a file
 * called `quad.png` from a model shown only the descriptor `[image quad.png ·
 * image/png · 96×96 · …]` and asked for four quadrant colours. An arc whose one
 * semantic assertion can be satisfied by guessing is an arc that would pass
 * through a real serialization defect — if `resolveRequestImages` returned an
 * empty map, or a serializer missed its byte lookup, the child would see the
 * descriptor, guess the canonical order, and the suite would stay green.
 * Permuting it makes the answer evidence that bytes arrived.
 */
export const QUADRANT_COLOURS = ['blue', 'white', 'red', 'green'] as const

const RGB: readonly (readonly [number, number, number])[] = [
  [0, 0, 255],
  [255, 255, 255],
  [255, 0, 0],
  [0, 160, 0],
]

/**
 * A PNG split into four equal quadrants, in `QUADRANT_COLOURS` order —
 * top-left, top-right, bottom-left, bottom-right.
 *
 * 96×96 is the size two live probes read correctly on the shipped vision route,
 * which is why the arcs use it: a smaller fixture would make a wrong answer a
 * plausible outcome and an arc failure ambiguous.
 */
export function quadPng(width: number, height: number = width): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3))
  let at = 0
  for (let y = 0; y < height; y++) {
    raw[at++] = 0
    for (let x = 0; x < width; x++) {
      const colour = RGB[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]!
      raw[at++] = colour[0]
      raw[at++] = colour[1]
      raw[at++] = colour[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
