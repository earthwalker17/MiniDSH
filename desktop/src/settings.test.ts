import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings, normalizeFolders, PORT_MAX, PORT_MIN, readSettings, sanitizeSettings, withCurrentFolder, withoutFolder, writeSettings, type DesktopSettings } from './settings.ts'

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'minidsh-desktop-settings-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('desktop settings', () => {
  it('reads a missing file as the defaults, with no problem to log', () => {
    expect(readSettings(join(scratch(), 'nope', 'settings.json'))).toEqual({ settings: defaultSettings(), problems: [] })
  })

  it('reads malformed JSON and a non-object as the defaults, and says so', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'a.json'), '{"version":1,')
    writeFileSync(join(dir, 'b.json'), '[1,2]')
    for (const name of ['a.json', 'b.json']) {
      const { settings, problems } = readSettings(join(dir, name))
      expect(settings).toEqual(defaultSettings())
      expect(problems).toHaveLength(1)
    }
  })

  it('drops an invalid field ALONE and keeps the rest', () => {
    const { settings, problems } = sanitizeSettings(
      { version: 1, folders: ['/work/a', 'relative', 7, '/work/a/', '/work/b'], port: 50_000, window: { x: 10, y: 20, width: 800, height: 600, maximized: false } },
      'linux',
    )
    expect(settings).toEqual({ version: 1, folders: ['/work/a', '/work/b'], window: { x: 10, y: 20, width: 800, height: 600, maximized: false } })
    expect(problems).toEqual([expect.stringMatching(/dropped 3 folder entries/), expect.stringMatching(/"port"/)])
    const bad = sanitizeSettings({ version: 1, folders: 'not a list', port: 30_000, window: { x: 1.5, y: 0, width: 800, height: 600, maximized: false } }, 'linux')
    expect(bad.settings).toEqual({ version: 1, folders: [], port: 30_000 })
    expect(bad.problems).toEqual([expect.stringMatching(/"folders"/), expect.stringMatching(/"window"/)])
  })

  it('validates the port range exactly: [20000, 45000), integers only', () => {
    const port = (value: unknown): number | undefined => sanitizeSettings({ version: 1, folders: [], port: value }, 'linux').settings.port
    expect([PORT_MIN - 1, PORT_MIN, PORT_MAX - 1, PORT_MAX, 30_000.5, '30000', null].map(port)).toEqual([undefined, PORT_MIN, PORT_MAX - 1, undefined, undefined, undefined, undefined])
  })

  it('rejects window bounds that are not plain integers, empty or absurd', () => {
    const ok = { x: -1920, y: 0, width: 1280, height: 720, maximized: true }
    expect(sanitizeSettings({ version: 1, folders: [], window: ok }, 'linux').settings.window).toEqual(ok)
    for (const window of [{ ...ok, width: 0 }, { ...ok, height: -5 }, { ...ok, x: 1e9 }, { ...ok, maximized: 'yes' }, { ...ok, y: Number.NaN }, null, [1, 2, 3, 4]]) {
      expect(sanitizeSettings({ version: 1, folders: [], window }, 'linux').settings.window).toBeUndefined()
    }
  })

  it('keeps an unknown version readable but names it', () => {
    const { settings, problems } = sanitizeSettings({ version: 2, folders: ['/a'] }, 'linux')
    expect(settings.folders).toEqual(['/a'])
    expect(problems).toEqual([expect.stringMatching(/unknown settings version 2/)])
  })

  it('dedups folders case-insensitively on Windows and exactly elsewhere, first spelling and order kept', () => {
    expect(normalizeFolders(['C:\\Work\\A', 'c:\\work\\a\\', 'D:\\b', 'C:\\work\\A', 'rel\\x', '\\\\srv\\share\\p'], 'win32')).toEqual(['C:\\Work\\A', 'D:\\b', '\\\\srv\\share\\p'])
    expect(normalizeFolders(['/Work/A', '/work/a', '/Work/A/'], 'linux')).toEqual(['/Work/A', '/work/a'])
  })

  it('makes a folder current by moving it to the front, and removes one by path identity', () => {
    const settings: DesktopSettings = { version: 1, folders: ['C:\\a', 'C:\\b', 'C:\\c'] }
    expect(withCurrentFolder(settings, 'c:\\B', 'win32').folders).toEqual(['c:\\B', 'C:\\a', 'C:\\c'])
    expect(withCurrentFolder(settings, 'C:\\d', 'win32').folders).toEqual(['C:\\d', 'C:\\a', 'C:\\b', 'C:\\c'])
    expect(withoutFolder(settings, 'c:\\A\\', 'win32').folders).toEqual(['C:\\b', 'C:\\c'])
    expect(withoutFolder({ version: 1, folders: ['/a', '/A'] }, '/A', 'linux').folders).toEqual(['/a'])
  })

  it('writes atomically into a directory it creates, round-trips, and stores nothing else', () => {
    const dir = join(scratch(), 'user', 'data')
    const path = join(dir, 'settings.json')
    const settings = { version: 1, folders: ['/w/one', '/w/two'], port: 31_234, window: { x: 0, y: 0, width: 900, height: 700, maximized: false }, secret: 'never' } as DesktopSettings
    expect(writeSettings(path, settings, 'linux')).toEqual([])
    expect(readdirSync(dir)).toEqual(['settings.json'])
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(Object.keys(stored)).toEqual(['version', 'folders', 'port', 'window'])
    expect(readSettings(path, 'linux')).toEqual({ settings: { version: 1, folders: ['/w/one', '/w/two'], port: 31_234, window: { x: 0, y: 0, width: 900, height: 700, maximized: false } }, problems: [] })
    // A second write replaces the first, again leaving no temp file behind.
    writeSettings(path, { version: 1, folders: ['/w/two'] }, 'linux')
    expect(readSettings(path, 'linux').settings).toEqual({ version: 1, folders: ['/w/two'] })
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('never writes a value that would not read back, and reports what it dropped', () => {
    const path = join(scratch(), 'settings.json')
    const problems = writeSettings(path, { version: 1, folders: ['relative'], port: 80 }, 'linux')
    expect(problems).toHaveLength(2)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, folders: [] })
  })

  it('leaves the old file intact and no temp file when the rename fails', () => {
    const dir = scratch()
    // A directory where the file should be: the rename cannot replace it.
    const path = join(dir, 'settings.json')
    writeSettings(join(dir, 'settings.json', 'inner.json'), { version: 1, folders: [] }, 'linux')
    expect(() => writeSettings(path, { version: 1, folders: [] }, 'linux')).toThrow()
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })
})
