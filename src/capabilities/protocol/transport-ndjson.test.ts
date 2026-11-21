/** The stream carrier's framing: one frame per `\n`, and nothing else ends a line. */
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { describe, expect, it } from 'vitest'
import { NdjsonTransport } from './transport-ndjson.ts'

const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)

interface Reading {
  readonly input: PassThrough
  readonly output: PassThrough
  readonly transport: NdjsonTransport
  readonly frames: unknown[]
  readonly malformed: string[]
  ends: number
}

function reading(): Reading {
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = new NdjsonTransport(input, output)
  const state: Reading = { input, output, transport, frames: [], malformed: [], ends: 0 }
  transport.start({
    onFrame: (frame) => state.frames.push(frame),
    onEnd: () => state.ends++,
    onMalformed: (line) => state.malformed.push(line),
  })
  return state
}

/** Resolves once the stream has handed everything written so far to its listeners. */
const drained = (stream: PassThrough): Promise<void> => new Promise((resolve) => stream.write('', () => setImmediate(resolve)))

describe('the NDJSON carrier', () => {
  it('reads a frame that holds U+2028 or U+2029 as ONE frame', async () => {
    const one = reading()
    const text = `a${LS}b${PS}c`
    // Exactly what a client's JSON.stringify writes: both characters raw.
    const wire = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { text } })
    expect(wire.includes(LS) && wire.includes(PS), 'the fixture must carry both characters unescaped').toBe(true)
    one.input.write(`${wire}\n`)
    await drained(one.input)
    expect(one.malformed, `malformed lines: ${JSON.stringify(one.malformed)}`).toEqual([])
    expect(one.frames).toEqual([{ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { text } }])
  })

  it('writes both characters escaped, so a line reader on the other side gets one line per frame', async () => {
    const one = reading()
    const lines: string[] = []
    const chunks: Buffer[] = []
    one.output.on('data', (chunk: Buffer) => chunks.push(chunk))
    const reader = createInterface({ input: one.output, crlfDelay: Infinity })
    reader.on('line', (line) => lines.push(line))
    const text = `said ${LS} and ${PS}.`
    one.transport.send({ jsonrpc: '2.0', method: 'session.event', params: { text } })
    one.transport.send({ jsonrpc: '2.0', id: 7, result: {} })
    await drained(one.output)
    const wire = Buffer.concat(chunks).toString('utf8')
    expect(wire.includes(LS) || wire.includes(PS), `raw separators on the wire: ${JSON.stringify(wire)}`).toBe(false)
    expect(wire).toContain('\\u2028')
    expect(wire).toContain('\\u2029')
    expect(lines, `lines read: ${JSON.stringify(lines)}`).toHaveLength(2)
    // The escape is the same character to every JSON parser.
    expect(JSON.parse(lines[0]!)).toEqual({ jsonrpc: '2.0', method: 'session.event', params: { text } })
    reader.close()
  })

  it('reassembles a frame split across chunks, inside a multi-byte character too', async () => {
    const one = reading()
    const bytes = Buffer.from(`${JSON.stringify({ id: 1, text: `caf${String.fromCharCode(0xe9)} ${LS} ${String.fromCodePoint(0x1f600)}` })}\n${JSON.stringify({ id: 2 })}\n`, 'utf8')
    // One byte at a time: every multi-byte character is cut at every position.
    for (const byte of bytes) one.input.write(Buffer.from([byte]))
    await drained(one.input)
    expect(one.malformed, `malformed lines: ${JSON.stringify(one.malformed)}`).toEqual([])
    expect(one.frames).toEqual([{ id: 1, text: `caf${String.fromCharCode(0xe9)} ${LS} ${String.fromCodePoint(0x1f600)}` }, { id: 2 }])
  })

  it('accepts CRLF and blank lines, and reports a malformed line without ending', async () => {
    const one = reading()
    one.input.write('{"id":1}\r\n\r\n\nnot json {{{\n{"id":2}\n')
    await drained(one.input)
    expect(one.frames).toEqual([{ id: 1 }, { id: 2 }])
    expect(one.malformed).toEqual(['not json {{{'])
    expect(one.ends).toBe(0)
  })

  it('delivers a last frame with no terminator when the input ends, then says so once', async () => {
    const one = reading()
    one.input.end('{"id":1}\n{"id":2}')
    await new Promise((resolve) => one.input.once('close', resolve))
    expect(one.frames).toEqual([{ id: 1 }, { id: 2 }])
    // `end` and `close` both arrive on a stream that ended; one hang-up is one call.
    expect(one.ends).toBe(1)
  })

  it('treats a failed input as a client that is gone, not as an uncaught error', async () => {
    const one = reading()
    one.input.destroy(new Error('the pipe broke'))
    await new Promise((resolve) => one.input.once('close', resolve))
    expect(one.ends).toBe(1)
  })

  it('reads and reports nothing after stop()', async () => {
    const one = reading()
    one.input.write('{"id":1}\n')
    await drained(one.input)
    one.transport.stop()
    // stop() pauses the stream it was given; resumed, it must still find no listener of this transport.
    one.input.resume()
    one.input.end('{"id":2}\n')
    await new Promise((resolve) => one.input.once('close', resolve))
    expect(one.frames).toEqual([{ id: 1 }])
    expect(one.ends).toBe(0)
    const chunks: Buffer[] = []
    one.output.on('data', (chunk: Buffer) => chunks.push(chunk))
    one.transport.send({ id: 3 })
    await drained(one.output)
    expect(Buffer.concat(chunks).toString('utf8')).toBe('')
  })
})
