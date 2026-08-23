/**
 * Newline-delimited JSON framing over a byte stream pair. One compact JSON
 * frame per `\n`-terminated line; malformed lines are ignored (reported to a
 * hook, never fatal). The output stream is reserved for frames — host logging
 * belongs on stderr.
 */
import { createInterface, type Interface } from 'node:readline'

export interface TransportHooks {
  readonly onFrame: (frame: unknown) => void
  /** The input ended (client hung up). Not called after an explicit `stop()`. */
  readonly onEnd: () => void
  readonly onMalformed?: (line: string) => void
}

export class NdjsonTransport {
  private readonly input: NodeJS.ReadableStream
  private readonly output: NodeJS.WritableStream
  private reader: Interface | undefined
  private closed = false

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
    this.input = input
    this.output = output
  }

  start(hooks: TransportHooks): void {
    this.reader = createInterface({ input: this.input, crlfDelay: Infinity, terminal: false })
    this.reader.on('line', (line) => {
      if (this.closed || line.trim() === '') return
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        hooks.onMalformed?.(line)
        return
      }
      hooks.onFrame(frame)
    })
    this.reader.on('close', () => {
      if (!this.closed) hooks.onEnd()
    })
  }

  send(frame: unknown): void {
    if (this.closed) return
    try {
      this.output.write(`${JSON.stringify(frame)}\n`)
    } catch {
      // The peer is gone; the close path will run via onEnd or stop().
    }
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    this.reader?.close()
    this.reader = undefined
    const input = this.input as { pause?: () => void }
    if (typeof input.pause === 'function') input.pause()
  }
}
