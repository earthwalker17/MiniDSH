/**
 * The slash menu model: ranking tiers, the highlight following its item
 * across refilters, wrapping and the visible window, Esc holding for one
 * draft, option completion, and `exact` entries that Enter only completes.
 */
import { describe, expect, it } from 'vitest'
import { Palette, rank, type PaletteEntry, type PaletteOption } from './palette.ts'

const ENTRIES: readonly PaletteEntry[] = [
  { name: 'help', description: 'Show the commands' },
  { name: 'model', args: '<id>', description: 'Switch the model' },
  { name: 'mode', description: 'Switch the mode' },
  { name: 'resume', args: '<id>', description: 'Resume a session' },
  { name: 'quit', description: 'Leave', exact: true },
  { name: 'demo', description: 'A demonstration' },
]
const MODELS: readonly PaletteOption[] = [
  { value: 'deepseek-chat', description: 'fast' },
  { value: 'deepseek-reasoner', description: 'thinks' },
  { value: 'claude-fable-5-2' },
]

const palette = (): Palette => new Palette(ENTRIES, (command) => (command === 'model' ? MODELS : undefined))
const labels = (p: Palette): string[] => p.view(50).items.map((i) => i.label)
const highlighted = (p: Palette): string | undefined => p.accept()?.insert

describe('rank', () => {
  const names = ['model', 'mode', 'demo', 'compact', 'memory', 'MOTD']
  const by = (query: string): string[] => rank(names, query, (n) => [n])

  it('puts prefix before substring before subsequence, drops the rest, case-insensitively', () => {
    expect(by('mo')).toEqual(['model', 'mode', 'MOTD', 'demo', 'memory'])
    expect(by('MO')).toEqual(by('mo'))
    expect(by('mdl')).toEqual(['model'])
    expect(by('zz')).toEqual([])
  })

  it('keeps the input order within a tier, and an empty query matches everything in order', () => {
    expect(by('')).toEqual(names)
    expect(rank(['b-x', 'a-x', 'c-x'], 'x', (n) => [n])).toEqual(['b-x', 'a-x', 'c-x'])
  })

  it('takes the best tier over every key of an item', () => {
    const items = [
      { id: 1, keys: ['xqux', 'quit'] },
      { id: 2, keys: ['quack'] },
    ]
    expect(rank(items, 'qu', (i) => i.keys).map((i) => i.id)).toEqual([1, 2])
    expect(rank(items, 'qu', (i) => i.keys.slice(0, 1)).map((i) => i.id)).toEqual([2, 1])
  })
})

describe('Palette', () => {
  it('opens on a slash draft without a line break, ranking commands by name', () => {
    const p = palette()
    p.update('/')
    expect(p.open).toBe(true)
    expect(labels(p)).toEqual(['/help', '/model <id>', '/mode', '/resume <id>', '/quit', '/demo'])
    p.update('/mo')
    expect(labels(p)).toEqual(['/model <id>', '/mode', '/demo'])
    expect(p.view(50).items[0]).toEqual({ label: '/model <id>', description: 'Switch the model', insert: '/model', run: true })
    for (const draft of ['', 'hello', 'a /mo', '/mo\nmore', '/zzz', '/help x', '/model a b', '/ x']) {
      p.update(draft)
      expect(p.open, JSON.stringify(draft)).toBe(false)
      expect(p.accept()).toBeUndefined()
      expect(p.complete()).toBeUndefined()
    }
  })

  it('keeps the highlight on the same item while the draft refilters, else resets to the first', () => {
    const p = palette()
    p.update('/')
    p.move(2)
    expect(highlighted(p)).toBe('/mode')
    p.update('/m')
    expect(labels(p)).toEqual(['/model <id>', '/mode', '/resume <id>', '/demo'])
    expect(highlighted(p)).toBe('/mode')
    expect(p.view(50).selected).toBe(1)
    p.update('/mod')
    expect(highlighted(p)).toBe('/mode')
    p.update('/q')
    expect(highlighted(p)).toBe('/quit')
    p.update('/')
    expect(highlighted(p)).toBe('/quit')
    p.update('/he')
    expect(highlighted(p)).toBe('/help')
  })

  it('wraps in both directions', () => {
    const p = palette()
    p.update('/')
    p.move(-1)
    expect(highlighted(p)).toBe('/demo')
    p.move(1)
    expect(highlighted(p)).toBe('/help')
    p.move(13)
    expect(highlighted(p)).toBe('/model')
  })

  it('keeps the selection inside the visible window', () => {
    const p = palette()
    p.update('/')
    expect(p.view(3)).toMatchObject({ selected: 0, top: 0 })
    p.move(3)
    expect(p.view(3)).toMatchObject({ selected: 3, top: 1 })
    p.move(2)
    expect(p.view(3)).toMatchObject({ selected: 5, top: 3 })
    p.move(-1)
    expect(p.view(3)).toMatchObject({ selected: 4, top: 3 })
    p.move(2)
    expect(p.view(3)).toMatchObject({ selected: 0, top: 0 })
    p.move(-1)
    expect(p.view(3)).toMatchObject({ selected: 5, top: 3 })
    // A taller window than there are items starts at the top.
    expect(p.view(10)).toMatchObject({ selected: 5, top: 0 })
  })

  it('stays dismissed for the draft Esc was pressed on, and reopens when it changes', () => {
    const p = palette()
    p.update('/m')
    p.dismiss()
    expect(p.open).toBe(false)
    p.update('/m')
    expect(p.open).toBe(false)
    p.update('/mo')
    expect(p.open).toBe(true)
    p.update('/m')
    expect(p.open).toBe(true)
  })

  it('ranks a command’s options after one space, and completes and runs the full command', () => {
    const p = palette()
    p.update('/model ')
    expect(labels(p)).toEqual(['deepseek-chat', 'deepseek-reasoner', 'claude-fable-5-2'])
    expect(p.view(50).items[2]).toEqual({ label: 'claude-fable-5-2', description: '', insert: '/model claude-fable-5-2', run: true })
    p.update('/model reas')
    expect(p.complete()).toBe('/model deepseek-reasoner')
    expect(p.accept()).toMatchObject({ insert: '/model deepseek-reasoner', run: true })
    p.update('/model deep')
    expect(p.complete()).toBe('/model deepseek-')
    p.update('/model deepseek-chat extra')
    expect(p.open).toBe(false)
  })

  it('Tab: one match gets a space when the command takes an argument; several get their common prefix; fuzzy ones the highlight', () => {
    const p = palette()
    p.update('/res')
    expect(p.complete()).toBe('/resume ')
    p.update('/he')
    expect(p.complete()).toBe('/help')
    p.update('/mo')
    expect(p.complete()).toBe('/mode')
    p.update('/rsm')
    expect(p.complete()).toBe('/resume ')
    p.update('/e')
    expect(labels(p)).toEqual(['/help', '/model <id>', '/mode', '/resume <id>', '/demo'])
    // The highlight followed /resume from the previous draft.
    expect(highlighted(p)).toBe('/resume')
    expect(p.complete()).toBe('/resume ')
    p.move(1)
    expect(p.complete()).toBe('/demo')
  })

  it('an exact entry runs only on its full name; Enter on a partial match completes it', () => {
    const p = palette()
    p.update('/qu')
    expect(p.accept()).toEqual({ label: '/quit', description: 'Leave', insert: '/quit', run: false })
    expect(p.complete()).toBe('/quit')
    p.update('/quit')
    expect(p.accept()?.run).toBe(true)
    // A command with an argument hint and no argument yet still runs: it shows its own usage.
    p.update('/resu')
    expect(p.accept()).toMatchObject({ insert: '/resume', run: true })
  })
})
