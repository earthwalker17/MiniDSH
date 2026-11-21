/**
 * Newline-delimited JSON framing over a byte stream pair. One compact JSON
 * frame per `\n`-terminated line; malformed lines are ignored (reported to a
 * hook, never fatal). The output stream is reserved for frames — host logging
 * belongs on stderr.
 *
 * A LINE ENDS AT `\n` AND NOWHERE ELSE. `node:readline` also ends one at
 * U+2028 and U+2029, which `JSON.stringify` writes raw inside a string: a
 * frame whose text held either arrived as two malformed halves, was dropped,
 * and the request it carried was never answered. So the reader splits by hand,
 * and the writer escapes both characters, so a client that does read with a
 * line reader is safe as well.
 */
import { StringDecoder } from 'node:string_decoder'

export interface TransportHooks {
  readonly onFrame: (frame: unknown) => void
  /** The input ended (client hung up). Not called after an explicit `stop()`. */
  readonly onEnd: () => void
  readonly onMalformed?: (line: string) => void
}

// Built from code points: written as literals, the two characters are line
// ends to an editor, and to a regular expression literal as well.
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
const SEPARATORS = new RegExp(`[${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, 'g')
/** Either character can only sit inside a JSON string, where its escape is the same character to every parser. */
const escapeSeparator = (character: string): string => (character === LINE_SEPARATOR ? '\\u2028' : '\\u2029')

export class NdjsonTransport {
  private readonly input: NodeJS.ReadableStream
  private readonly output: NodeJS.WritableStream
  /** Removes this transport's listeners from the input; set while it reads. */
  private unlisten: (() => void) | undefined
  private closed = false

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
    this.input = input
    this.output = output
  }

  start(hooks: TransportHooks): void {
    // A multi-byte character can straddle two chunks; the decoder holds the
    // partial one back instead of emitting a replacement character.
    const decoder = new StringDecoder('utf8')
    let pending = ''
    let ended = false

    // A `\r` before the `\n` needs no handling: outside a string it is JSON
    // whitespace, and inside one it is always escaped.
    const line = (text: string): void => {
      if (this.closed || text.trim() === '') return
      let frame: unknown
      try {
        frame = JSON.parse(text)
      } catch {
        hooks.onMalformed?.(text)
        return
      }
      hooks.onFrame(frame)
    }

    const onData = (chunk: Buffer | string): void => {
      if (this.closed) return
      // Only the text that just arrived can hold a new terminator, so a frame
      // delivered in many chunks is not rescanned from its start each time.
      let from = pending.length
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      let start = 0
      for (let at = pending.indexOf('\n', from); at !== -1; at = pending.indexOf('\n', from)) {
        line(pending.slice(start, at))
        start = at + 1
        from = start
      }
      pending = pending.slice(start)
    }

    // The input is done: it ended, it failed, or it was destroyed. Nothing
    // more will arrive on any of the three, so each means the client is gone.
    const onEnd = (): void => {
      if (ended) return
      ended = true
      // A last frame with no terminator is still a frame.
      const rest = pending + decoder.end()
      pending = ''
      if (rest.length > 0) line(rest)
      this.unlisten?.()
      this.unlisten = undefined
      if (!this.closed) hooks.onEnd()
    }

    this.input.on('data', onData)
    this.input.on('end', onEnd)
    this.input.on('error', onEnd)
    this.input.on('close', onEnd)
    this.unlisten = () => {
      this.input.off('data', onData)
      this.input.off('end', onEnd)
      this.input.off('error', onEnd)
      this.input.off('close', onEnd)
    }
    // A stream someone paused does not start flowing because a listener was
    // added (`stop()` below pauses the one it is given).
    this.input.resume()
  }

  send(frame: unknown): void {
    if (this.closed) return
    try {
      this.output.write(`${JSON.stringify(frame).replace(SEPARATORS, escapeSeparator)}\n`)
    } catch {
      // The peer is gone; the close path will run via onEnd or stop().
    }
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    this.unlisten?.()
    this.unlisten = undefined
    const input = this.input as { pause?: () => void }
    if (typeof input.pause === 'function') input.pause()
  }
}
