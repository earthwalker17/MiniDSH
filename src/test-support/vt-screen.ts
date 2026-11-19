/**
 * A small terminal model for driving the full-screen terminal in tests: it
 * applies what the terminal writes (cursor moves, clears, SGR, the mode
 * switches `tty.ts` sets) to a main and an alternate screen, so a scripted
 * session can be asserted as screen TEXT. Lenient where `screen.test.ts`'s
 * applier is strict: that one proves the frame writer; this one reads a whole
 * session, bell, clipboard and mode table included, and records the modes.
 */
import { graphemes, graphemeWidth } from '../app/terminal/width.ts'

export class VtScreen {
  readonly width: number
  readonly height: number
  private main: string[][]
  private alt: string[][]
  private onAlt = false
  private x = 0
  private y = 0
  /** Private modes currently set (`?1049`, `?2004`, `?25`…), as the last h/l left them. */
  readonly modes = new Map<string, boolean>()
  bells = 0
  readonly clipboard: string[] = []
  /** Everything written while on the main screen, as text (the exit summary lands here). */
  mainText = ''

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.main = this.blank()
    this.alt = this.blank()
  }

  private blank(): string[][] {
    return Array.from({ length: this.height }, () => Array.from({ length: this.width }, () => ' '))
  }

  private get grid(): string[][] {
    return this.onAlt ? this.alt : this.main
  }

  get alternate(): boolean {
    return this.onAlt
  }

  /** Resizes the model as a terminal would before the program redraws. */
  resize(width: number, height: number): VtScreen {
    const next = new VtScreen(width, height)
    next.onAlt = this.onAlt
    for (const [key, value] of this.modes) next.modes.set(key, value)
    return next
  }

  write(bytes: string): void {
    let i = 0
    while (i < bytes.length) {
      const ch = bytes[i]!
      if (ch === '\x1b') {
        const rest = bytes.slice(i)
        // oxlint-disable-next-line no-control-regex
        const osc = /^\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/.exec(rest)
        if (osc) {
          if (osc[1] === '52') this.clipboard.push(Buffer.from(osc[2]!.replace(/^[a-z]*;/, ''), 'base64').toString('utf8'))
          i += osc[0].length
          continue
        }
        // oxlint-disable-next-line no-control-regex
        const csi = /^\x1b\[([?]?)([\d;]*)([A-Za-z])/.exec(rest)
        if (!csi) throw new Error(`an escape this model does not know: ${JSON.stringify(rest.slice(0, 10))}`)
        const [whole, priv, params, final] = csi
        if (final === 'H') {
          const [row, col] = params!.split(';').map((value) => Number(value || '1'))
          this.y = (row ?? 1) - 1
          this.x = (col ?? 1) - 1
        } else if (final === 'J') {
          if (this.onAlt) this.alt = this.blank()
          else this.main = this.blank()
        } else if (final === 'h' || final === 'l') {
          const on = final === 'h'
          for (const mode of params!.split(';')) {
            this.modes.set(`${priv}${mode}`, on)
            if (priv === '?' && mode === '1049') {
              this.onAlt = on
              if (on) this.alt = this.blank()
            }
          }
        }
        i += whole!.length
        continue
      }
      if (ch === '\x07') {
        this.bells++
        i++
        continue
      }
      if (ch === '\r') {
        this.x = 0
        i++
        continue
      }
      if (ch === '\n') {
        if (!this.onAlt) this.mainText += '\n'
        this.y = Math.min(this.height - 1, this.y + 1)
        this.x = 0
        i++
        continue
      }
      const g = graphemes(bytes.slice(i, i + 16))[0]!
      const w = graphemeWidth(g)
      if (!this.onAlt) this.mainText += g
      if (this.y < this.height && this.x < this.width) {
        this.grid[this.y]![this.x] = g
        if (w === 2 && this.x + 1 < this.width) this.grid[this.y]![this.x + 1] = ''
      }
      this.x += w
      i += g.length
    }
  }

  /** The visible screen, one string per row, trailing blanks trimmed. */
  rows(): string[] {
    return this.grid.map((row) => row.join('').replace(/ +$/, ''))
  }

  text(): string {
    return this.rows().join('\n')
  }
}
