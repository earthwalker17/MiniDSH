/**
 * The slash menu: what the composer's draft offers while it starts with `/`.
 * Pure — the surface feeds it every draft change and maps Up/Down, Tab, Enter
 * and Esc to `move`, `complete`, `accept` and `dismiss`; drawing is the
 * renderer's.
 *
 * Two levels and no more: a command name (`/mo` ranks the commands), then one
 * argument from a list the caller supplies (`/model de` ranks the model ids).
 * Anything else typed after a command closes the menu, so a free-form argument
 * is never fought over. The highlight follows the ITEM, not the row, so typing
 * one more letter does not move the selection out from under a person; an Esc
 * holds for exactly the draft it was pressed on.
 *
 * Enter on a highlighted item runs it — a command whose argument is missing
 * shows its own usage, which beats a menu guessing — except an `exact` entry
 * (one too consequential to run from a prefix, such as quitting), where Enter
 * on a partial match only completes it.
 */

export interface PaletteEntry {
  /** Without the leading `/`. */
  readonly name: string
  /** A usage hint, e.g. `<id>`. */
  readonly args?: string
  readonly description: string
  /** Enter on a partial match only completes it. */
  readonly exact?: true
}

export interface PaletteOption {
  readonly value: string
  readonly description?: string
}

export interface PaletteItem {
  readonly label: string
  readonly description: string
  /** The full draft text choosing it produces. */
  readonly insert: string
  /** Enter runs it now (false: it only completes). */
  readonly run: boolean
}

export interface PaletteView {
  /** Every matching item; the visible window is `items.slice(top, top + maxRows)`. */
  readonly items: readonly PaletteItem[]
  readonly selected: number
  /** The first visible index. */
  readonly top: number
}

/** 0 prefix, 1 substring, 2 subsequence (in order), undefined no match. */
function tier(key: string, query: string): number | undefined {
  if (key.startsWith(query)) return 0
  if (key.includes(query)) return 1
  let at = 0
  for (const ch of key) if (at < query.length && query.startsWith(ch, at)) at += ch.length
  return at >= query.length ? 2 : undefined
}

/** Case-insensitive: prefix before substring before subsequence; non-matches dropped; stable within a tier. */
export function rank<T>(items: readonly T[], query: string, keyOf: (item: T) => readonly string[]): T[] {
  const q = query.toLowerCase()
  const scored: { readonly item: T; readonly tier: number; readonly index: number }[] = []
  items.forEach((item, index) => {
    let best: number | undefined
    for (const key of keyOf(item)) {
      const t = tier(key.toLowerCase(), q)
      if (t !== undefined && (best === undefined || t < best)) best = t
    }
    if (best !== undefined) scored.push({ item, tier: best, index })
  })
  scored.sort((a, b) => a.tier - b.tier || a.index - b.index)
  return scored.map((s) => s.item)
}

function commonPrefix(values: readonly string[]): string {
  let prefix = values[0] ?? ''
  for (const value of values) {
    let n = 0
    while (n < prefix.length && n < value.length && prefix[n] === value[n]) n++
    prefix = prefix.slice(0, n)
  }
  return prefix
}

/** An item and, for a command, its entry: Tab asks whether completing it should leave room for an argument. */
interface Choice {
  readonly item: PaletteItem
  readonly entry?: PaletteEntry
}

export class Palette {
  private readonly entries: readonly PaletteEntry[]
  private readonly options: (command: string) => readonly PaletteOption[] | undefined
  private draft = ''
  private choices: readonly Choice[] = []
  private selected = 0
  private top = 0
  private dismissed: string | undefined

  constructor(entries: readonly PaletteEntry[], options: (command: string) => readonly PaletteOption[] | undefined) {
    this.entries = entries
    this.options = options
  }

  get open(): boolean {
    return this.choices.length > 0
  }

  update(draft: string): void {
    const previous = this.choices[this.selected]?.item.insert
    this.draft = draft
    if (draft !== this.dismissed) this.dismissed = undefined
    this.choices = this.dismissed === undefined ? this.match(draft) : []
    const follow = previous === undefined ? -1 : this.choices.findIndex((c) => c.item.insert === previous)
    this.selected = Math.max(0, follow)
    if (follow < 0) this.top = 0
  }

  view(maxRows: number): PaletteView {
    const rows = Math.max(1, Math.floor(maxRows) || 1)
    const count = this.choices.length
    if (this.selected < this.top) this.top = this.selected
    else if (this.selected >= this.top + rows) this.top = this.selected - rows + 1
    this.top = Math.max(0, Math.min(this.top, count - rows))
    return { items: this.choices.map((c) => c.item), selected: this.selected, top: this.top }
  }

  move(delta: number): void {
    const count = this.choices.length
    if (count === 0) return
    this.selected = (((this.selected + Math.trunc(delta)) % count) + count) % count
  }

  dismiss(): void {
    this.dismissed = this.draft
    this.choices = []
    this.selected = 0
    this.top = 0
  }

  accept(): PaletteItem | undefined {
    return this.choices[this.selected]?.item
  }

  /**
   * Tab. One match, or one whose insert extends the draft: its insert, plus a
   * space when the command takes an argument. Several that extend the draft:
   * their longest common prefix. Only fuzzy matches: the highlighted one.
   */
  complete(): string | undefined {
    if (this.choices.length === 0) return undefined
    const single = (c: Choice): string => (c.entry !== undefined && this.takesArgs(c.entry) ? `${c.item.insert} ` : c.item.insert)
    if (this.choices.length === 1) return single(this.choices[0]!)
    const draft = this.draft.toLowerCase()
    const extending = this.choices.filter((c) => c.item.insert.toLowerCase().startsWith(draft))
    if (extending.length === 1) return single(extending[0]!)
    if (extending.length > 1) return commonPrefix(extending.map((c) => c.item.insert))
    return single(this.choices[this.selected]!)
  }

  private match(draft: string): Choice[] {
    if (!draft.startsWith('/') || draft.includes('\n')) return []
    const body = draft.slice(1)
    const space = body.indexOf(' ')
    if (space < 0) {
      return rank(this.entries, body, (e) => [e.name]).map((entry) => ({
        item: {
          label: entry.args === undefined ? `/${entry.name}` : `/${entry.name} ${entry.args}`,
          description: entry.description,
          insert: `/${entry.name}`,
          run: entry.exact !== true || draft === `/${entry.name}`,
        },
        entry,
      }))
    }
    const command = body.slice(0, space)
    const query = body.slice(space + 1)
    if (command === '' || query.includes(' ')) return []
    const options = this.options(command)
    if (options === undefined) return []
    return rank(options, query, (o) => [o.value]).map((option) => ({
      item: { label: option.value, description: option.description ?? '', insert: `/${command} ${option.value}`, run: true },
    }))
  }

  private takesArgs(entry: PaletteEntry): boolean {
    return entry.args !== undefined || this.options(entry.name) !== undefined
  }
}
